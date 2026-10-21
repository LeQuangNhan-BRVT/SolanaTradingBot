import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { JupiterQuote } from "./shadow";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

type JupiterSwapResponse = {
  swapTransaction?: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  simulationError?: unknown;
  error?: string;
};

export type LiveSwapExecution = {
  signature: string;
  wallet: string;
  inputDeltaRaw: string;
  outputDeltaRaw: string;
  prioritizationFeeLamports: number | null;
  computeUnitLimit: number | null;
};

export function liveTradingConfigError() {
  if ((process.env.TRADING_MODE ?? "paper") !== "live") return "TRADING_MODE must be live.";
  if (process.env.LIVE_TRADING_ENABLED !== "true") return "LIVE_TRADING_ENABLED must be true.";
  if (!process.env.SOLANA_RPC_URL) return "SOLANA_RPC_URL is required.";
  if (!process.env.SOLANA_PRIVATE_KEY_BASE58 && !process.env.SOLANA_PRIVATE_KEY_JSON && !process.env.SOLANA_KEYPAIR_PATH) return "A local Solana keypair is required.";
  return null;
}

export function assertLiveTradingConfigured() {
  const error = liveTradingConfigError();
  if (error) throw new Error(error);
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

async function tokenBalanceRaw(connection: Connection, owner: PublicKey, mint: string) {
  if (mint === WSOL_MINT) return BigInt(await connection.getBalance(owner, "confirmed"));
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, "confirmed");
  return accounts.value.reduce((sum, account) => {
    const amount = account.account.data.parsed.info.tokenAmount.amount as string;
    return sum + BigInt(amount);
  }, 0n);
}

async function buildJupiterSwap(quote: JupiterQuote, userPublicKey: string) {
  const url = process.env.JUPITER_SWAP_URL ?? "https://lite-api.jup.ag/swap/v1/swap";
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (process.env.JUPITER_API_KEY) headers["x-api-key"] = process.env.JUPITER_API_KEY;
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

export async function executeLiveSwap(quote: JupiterQuote, onSubmitted?: (signature: string) => Promise<void>) {
  assertLiveTradingConfigured();
  const wallet = loadLiveKeypair();
  const connection = liveConnection();
  const inputBefore = await tokenBalanceRaw(connection, wallet.publicKey, quote.inputMint);
  const outputBefore = await tokenBalanceRaw(connection, wallet.publicKey, quote.outputMint);
  const swap = await buildJupiterSwap(quote, wallet.publicKey.toBase58());
  const transaction = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction!, "base64"));
  transaction.sign([wallet]);
  const simulation = await connection.simulateTransaction(transaction, { sigVerify: true });
  if (simulation.value.err) throw new Error(`Live swap simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: Number(process.env.LIVE_SEND_MAX_RETRIES ?? 2), skipPreflight: process.env.LIVE_SKIP_PREFLIGHT === "true", preflightCommitment: "confirmed" });
  await onSubmitted?.(signature);
  const confirmation = swap.lastValidBlockHeight
    ? await connection.confirmTransaction({ signature, blockhash: transaction.message.recentBlockhash, lastValidBlockHeight: swap.lastValidBlockHeight }, "confirmed")
    : await connection.confirmTransaction(signature, "confirmed");
  if (confirmation.value.err) throw new Error(`Live swap confirmation failed: ${JSON.stringify(confirmation.value.err)} signature=${signature}`);
  const inputAfter = await tokenBalanceRaw(connection, wallet.publicKey, quote.inputMint);
  const outputAfter = await tokenBalanceRaw(connection, wallet.publicKey, quote.outputMint);
  const inputDelta = inputBefore > inputAfter ? inputBefore - inputAfter : 0n;
  const outputDelta = outputAfter > outputBefore ? outputAfter - outputBefore : 0n;
  if (outputDelta <= 0n) throw new Error(`Live swap confirmed but output balance did not increase. signature=${signature}`);
  return {
    signature,
    wallet: wallet.publicKey.toBase58(),
    inputDeltaRaw: inputDelta.toString(),
    outputDeltaRaw: outputDelta.toString(),
    prioritizationFeeLamports: typeof swap.prioritizationFeeLamports === "number" ? swap.prioritizationFeeLamports : null,
    computeUnitLimit: typeof swap.computeUnitLimit === "number" ? swap.computeUnitLimit : null,
  } satisfies LiveSwapExecution;
}

export { WSOL_MINT };
