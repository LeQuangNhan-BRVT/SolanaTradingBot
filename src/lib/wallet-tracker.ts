import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { z } from "zod";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

export class WalletAddressError extends Error {}
export function parseWalletAddress(address: string) {
  try { return new PublicKey(address.trim()).toBase58(); } catch { throw new WalletAddressError("Địa chỉ ví Solana không hợp lệ."); }
}

function connection() {
  const key = process.env.HELIUS_API_KEY;
  return new Connection(key ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}` : (process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"), "confirmed");
}

// Display helper: converts a raw integer amount to a decimal string without floating point.
export function formatUnits(raw: string | bigint, decimals: number) {
  const value = BigInt(raw), negative = value < 0n, digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals), fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export type TokenPrice = { priceUsd: string | null; symbol: string | null; name: string | null };
const pairSchema = z.object({ baseToken: z.object({ address: z.string(), symbol: z.string(), name: z.string() }), priceUsd: z.string().nullish(), liquidity: z.object({ usd: z.number().nullish() }).passthrough().nullish() }).passthrough();

export async function fetchTokenPrices(mints: string[]) {
  const result = new Map<string, TokenPrice>();
  const unique = [...new Set(mints)];
  for (let offset = 0; offset < unique.length; offset += 30) {
    const batch = unique.slice(offset, offset + 30);
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch.map(encodeURIComponent).join(",")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
    const parsed = z.array(pairSchema).safeParse(await response.json());
    if (!parsed.success) throw new Error("DexScreener response không đúng schema.");
    const best = new Map<string, z.infer<typeof pairSchema>>();
    for (const pair of parsed.data) { const current = best.get(pair.baseToken.address); if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) best.set(pair.baseToken.address, pair); }
    for (const [mint, pair] of best) result.set(mint, { priceUsd: pair.priceUsd && /^\d+(\.\d+)?$/.test(pair.priceUsd) ? pair.priceUsd : null, symbol: pair.baseToken.symbol || null, name: pair.baseToken.name || null });
  }
  return result;
}

export type Holding = { mint: string; amountRaw: string; decimals: number };
export async function getWalletHoldings(address: string) {
  const rpc = connection(), owner = new PublicKey(address);
  const [lamports, ...accountSets] = await Promise.all([rpc.getBalance(owner, "confirmed"), ...TOKEN_PROGRAMS.map((programId) => rpc.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(programId) }, "confirmed"))]);
  const holdings = new Map<string, Holding>();
  for (const set of accountSets) for (const account of set.value) {
    const info = account.account.data.parsed?.info as { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } | undefined;
    if (!info?.mint || !info.tokenAmount?.amount || typeof info.tokenAmount.decimals !== "number") continue;
    const current = holdings.get(info.mint);
    holdings.set(info.mint, { mint: info.mint, decimals: info.tokenAmount.decimals, amountRaw: (BigInt(current?.amountRaw ?? "0") + BigInt(info.tokenAmount.amount)).toString() });
  }
  return { lamports: String(lamports), tokens: [...holdings.values()].filter((item) => item.amountRaw !== "0") };
}

export async function getWalletBalances(addresses: string[]) {
  if (addresses.length === 0) return new Map<string, string>();
  const infos = await connection().getMultipleAccountsInfo(addresses.map((address) => new PublicKey(address)), "confirmed");
  return new Map(addresses.map((address, index) => [address, String(infos[index]?.lamports ?? 0)]));
}

export type TokenChange = { mint: string; deltaRaw: string; decimals: number };
export type WalletChange = { signature: string; blockTime: Date | null; failed: boolean; feeLamports: string; solDeltaLamports: string; tokenChanges: TokenChange[]; kind: "buy" | "sell" | "swap" | "receive" | "send" | "other" };

// Derives the wallet's net balance changes from one parsed transaction. Wrapped SOL is folded into SOL.
export function extractWalletChange(signature: string, tx: Pick<ParsedTransactionWithMeta, "blockTime" | "meta" | "transaction">, owner: string): WalletChange {
  const keys = tx.transaction.message.accountKeys.map((key) => typeof key === "string" ? key : key.pubkey.toBase58());
  const index = keys.indexOf(owner), meta = tx.meta;
  const fee = index === 0 && meta ? BigInt(meta.fee) : 0n;
  let solDelta = index >= 0 && meta ? BigInt(meta.postBalances[index] ?? 0) - BigInt(meta.preBalances[index] ?? 0) + fee : 0n;
  const deltas = new Map<string, { delta: bigint; decimals: number }>();
  const apply = (balances: NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"], sign: bigint) => { for (const balance of balances ?? []) { if (balance.owner !== owner) continue; const current = deltas.get(balance.mint) ?? { delta: 0n, decimals: balance.uiTokenAmount.decimals }; current.delta += sign * BigInt(balance.uiTokenAmount.amount); deltas.set(balance.mint, current); } };
  apply(meta?.preTokenBalances, -1n); apply(meta?.postTokenBalances, 1n);
  const wsol = deltas.get(WSOL_MINT); if (wsol) { solDelta += wsol.delta; deltas.delete(WSOL_MINT); }
  const tokenChanges = [...deltas].filter(([, item]) => item.delta !== 0n).map(([mint, item]) => ({ mint, deltaRaw: item.delta.toString(), decimals: item.decimals }));
  const up = tokenChanges.filter((item) => BigInt(item.deltaRaw) > 0n).length, down = tokenChanges.length - up;
  const kind: WalletChange["kind"] = meta?.err ? "other" : up === 1 && down === 0 && solDelta < 0n ? "buy" : down === 1 && up === 0 && solDelta > 0n ? "sell" : up >= 1 && down >= 1 ? "swap" : up > 0 || (tokenChanges.length === 0 && solDelta > 0n) ? "receive" : down > 0 || (tokenChanges.length === 0 && solDelta < 0n) ? "send" : "other";
  return { signature, blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null, failed: Boolean(meta?.err), feeLamports: fee.toString(), solDeltaLamports: solDelta.toString(), tokenChanges, kind };
}

export async function getWalletActivity(address: string, limit = 40) {
  const rpc = connection(), signatures = await rpc.getSignaturesForAddress(new PublicKey(address), { limit }, "confirmed");
  const changes: WalletChange[] = [];
  for (let offset = 0; offset < signatures.length; offset += 20) {
    const batch = signatures.slice(offset, offset + 20);
    const transactions = await rpc.getParsedTransactions(batch.map((item) => item.signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    transactions.forEach((tx, i) => { if (tx) changes.push(extractWalletChange(batch[i].signature, tx, address)); });
  }
  return changes;
}

export type TradedToken = { mint: string; decimals: number; boughtRaw: string; soldRaw: string; solSpentLamports: string; solReceivedLamports: string; trades: number; lastTradeAt: Date | null };
export function summarizeTradedTokens(changes: WalletChange[]): TradedToken[] {
  const summary = new Map<string, { decimals: number; bought: bigint; sold: bigint; spent: bigint; received: bigint; trades: number; last: Date | null }>();
  for (const change of changes) {
    if (change.failed || (change.kind !== "buy" && change.kind !== "sell" && change.kind !== "swap")) continue;
    for (const token of change.tokenChanges) {
      const item = summary.get(token.mint) ?? { decimals: token.decimals, bought: 0n, sold: 0n, spent: 0n, received: 0n, trades: 0, last: null };
      const delta = BigInt(token.deltaRaw);
      if (delta > 0n) item.bought += delta; else item.sold += -delta;
      if (change.kind === "buy") item.spent += -BigInt(change.solDeltaLamports);
      if (change.kind === "sell") item.received += BigInt(change.solDeltaLamports);
      item.trades += 1;
      if (change.blockTime && (!item.last || change.blockTime > item.last)) item.last = change.blockTime;
      summary.set(token.mint, item);
    }
  }
  return [...summary].map(([mint, item]) => ({ mint, decimals: item.decimals, boughtRaw: item.bought.toString(), soldRaw: item.sold.toString(), solSpentLamports: item.spent.toString(), solReceivedLamports: item.received.toString(), trades: item.trades, lastTradeAt: item.last })).sort((a, b) => (b.lastTradeAt?.getTime() ?? 0) - (a.lastTradeAt?.getTime() ?? 0));
}
