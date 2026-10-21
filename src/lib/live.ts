import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import type { JupiterQuote } from "./shadow";
import { extractWalletChange } from "./wallet-tracker";
import { executionFromChange } from "./live-safety";
import { jupiterHeaders } from "./price-feed";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

type JupiterSwapResponse = {
  swapTransaction?: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  simulationError?: unknown;
  error?: string;
};

export type LiveSide = "buy" | "sell";
export type PreparedSwap = { signature: string; wallet: string; lastValidBlockHeight: bigint };
export type LiveSwapExecution = {
  signature: string;
  wallet: string;
  slot: number | null;
  blockTime: Date | null;
  tokenMint: string;
  // Token received (buy) or sold (sell), raw units.
  tokenAmountRaw: string;
  // Total SOL spent including fees and rent (buy) or net SOL received after fees (sell).
  lamports: string;
  feeLamports: string;
  prioritizationFeeLamports: number | null;
  computeUnitLimit: number | null;
};

// Definitive failure: the transaction was never broadcast or failed on-chain, so the order can be closed out.
export class LiveSwapFailedError extends Error {}
// Outcome unknown after broadcasting: leave the order for the recovery job instead of guessing.
export class LiveSwapPendingError extends Error {}

export function liveTradingConfigError() {
  if ((process.env.TRADING_MODE ?? "paper") !== "live") return "TRADING_MODE must be live.";
  if (process.env.LIVE_TRADING_ENABLED !== "true") return "LIVE_TRADING_ENABLED must be true.";
  if (!process.env.SOLANA_RPC_URL) return "SOLANA_RPC_URL is required.";
  if (!hasLiveKeypair()) return "A local Solana keypair is required.";
  return null;
}

export function assertLiveTradingConfigured() {
  const error = liveTradingConfigError();
  if (error) throw new Error(error);
}

export function hasLiveKeypair() {
  return Boolean(process.env.SOLANA_PRIVATE_KEY_BASE58 || process.env.SOLANA_PRIVATE_KEY_JSON || process.env.SOLANA_KEYPAIR_PATH);
}

export function loadLiveKeypair() {
  if (process.env.SOLANA_PRIVATE_KEY_BASE58) return Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY_BASE58.trim()));
  if (process.env.SOLANA_PRIVATE_KEY_JSON) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_PRIVATE_KEY_JSON)));
  if (process.env.SOLANA_KEYPAIR_PATH) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.SOLANA_KEYPAIR_PATH, "utf8"))));
  throw new Error("No local Solana keypair configured.");
}

export function liveConnection() {
  return new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
}

async function buildJupiterSwap(quote: JupiterQuote, userPublicKey: string) {
  const url = process.env.JUPITER_SWAP_URL ?? "https://api.jup.ag/swap/v1/swap";
  const headers = { ...jupiterHeaders(), "content-type": "application/json" };
  const maxLamports = Number(process.env.LIVE_MAX_PRIORITY_FEE_LAMPORTS ?? 500_000);
  const body: Record<string, unknown> = { quoteResponse: quote, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true };
  if (maxLamports > 0) body.prioritizationFeeLamports = { priorityLevelWithMaxLamports: { maxLamports, priorityLevel: process.env.LIVE_PRIORITY_LEVEL ?? "high" } };
  if (process.env.JUPITER_DYNAMIC_SLIPPAGE === "true") body.dynamicSlippage = true;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => response.statusText) })) as JupiterSwapResponse;
  if (!response.ok || payload.error || !payload.swapTransaction) throw new Error(payload.error ?? `Jupiter swap HTTP ${response.status}`);
  if (payload.simulationError) throw new Error(`Jupiter swap build simulation failed: ${JSON.stringify(payload.simulationError)}`);
  return payload;
}

// Reads the confirmed transaction and derives exact amounts from its balance changes. Null when not yet available.
export async function fetchLiveExecution(connection: Connection, signature: string, wallet: string, tokenMint: string, side: LiveSide): Promise<LiveSwapExecution | null> {
  const tx = await connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) return null;
  const amounts = executionFromChange(extractWalletChange(signature, tx, wallet), side, tokenMint);
  return { signature, wallet, slot: tx.slot, blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null, tokenMint, ...amounts, prioritizationFeeLamports: null, computeUnitLimit: null };
}

export async function executeLiveSwap(quote: JupiterQuote, side: LiveSide, hooks: { beforeSend: (prepared: PreparedSwap) => Promise<void>; afterSend?: (signature: string) => Promise<void> }): Promise<LiveSwapExecution> {
  const tokenMint = side === "buy" ? quote.outputMint : quote.inputMint;
  // Phase 1: nothing has been broadcast yet, so every error is a definitive failure.
  let prepared: PreparedSwap, transaction: VersionedTransaction, swap: JupiterSwapResponse, connection: Connection;
  try {
    assertLiveTradingConfigured();
    const wallet = loadLiveKeypair();
    connection = liveConnection();
    swap = await buildJupiterSwap(quote, wallet.publicKey.toBase58());
    transaction = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction!, "base64"));
    transaction.sign([wallet]);
    const simulation = await connection.simulateTransaction(transaction, { sigVerify: true });
    if (simulation.value.err) throw new Error(`Live swap simulation failed: ${JSON.stringify(simulation.value.err)}`);
    // Without Jupiter's value, over-estimate expiry: recovery waits longer but never fails a transaction that could still land.
    const lastValidBlockHeight = swap.lastValidBlockHeight ? BigInt(swap.lastValidBlockHeight) : BigInt(await connection.getBlockHeight("confirmed")) + 300n;
    prepared = { signature: bs58.encode(transaction.signatures[0]), wallet: wallet.publicKey.toBase58(), lastValidBlockHeight };
    await hooks.beforeSend(prepared);
  } catch (error) {
    throw new LiveSwapFailedError(error instanceof Error ? error.message : String(error));
  }

  // Phase 2: the signature is persisted; from here on only an on-chain error is definitive.
  try {
    await connection.sendRawTransaction(transaction.serialize(), { maxRetries: Number(process.env.LIVE_SEND_MAX_RETRIES ?? 2), skipPreflight: process.env.LIVE_SKIP_PREFLIGHT === "true", preflightCommitment: "confirmed" });
    await hooks.afterSend?.(prepared.signature);
    const confirmation = await connection.confirmTransaction({ signature: prepared.signature, blockhash: transaction.message.recentBlockhash, lastValidBlockHeight: Number(prepared.lastValidBlockHeight) }, "confirmed");
    if (confirmation.value.err) throw new LiveSwapFailedError(`Live swap failed on-chain: ${JSON.stringify(confirmation.value.err)} signature=${prepared.signature}`);
  } catch (error) {
    if (error instanceof LiveSwapFailedError) throw error;
    throw new LiveSwapPendingError(`Live swap outcome unknown, left for recovery: ${error instanceof Error ? error.message : String(error)} signature=${prepared.signature}`);
  }

  let execution: LiveSwapExecution | null = null;
  for (let attempt = 0; attempt < 5 && !execution; attempt++) {
    execution = await fetchLiveExecution(connection, prepared.signature, prepared.wallet, tokenMint, side).catch(() => null);
    if (!execution) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!execution) throw new LiveSwapPendingError(`Live swap confirmed but transaction details unavailable, left for recovery. signature=${prepared.signature}`);
  return { ...execution, prioritizationFeeLamports: typeof swap.prioritizationFeeLamports === "number" ? swap.prioritizationFeeLamports : null, computeUnitLimit: typeof swap.computeUnitLimit === "number" ? swap.computeUnitLimit : null };
}

export { WSOL_MINT };
