import { Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { MAX_SUPPORTED_TX_VERSION } from "./solana";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
// Jito tip accounts: tips are a large share of the fees memecoin traders pay on top of network and priority fees.
const JITO_TIP_ACCOUNTS = new Set(["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt", "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"]);

export function rpcConnection() {
  const key = process.env.HELIUS_API_KEY;
  return new Connection(key ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}` : (process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"), "confirmed");
}

// ---------- DexScreener (free, batched) ----------
const pairSchema = z.object({
  dexId: z.string(), pairAddress: z.string(), baseToken: z.object({ address: z.string(), symbol: z.string(), name: z.string() }), priceUsd: z.string().nullish(),
  txns: z.object({ h24: z.object({ buys: z.number(), sells: z.number() }).partial().nullish() }).passthrough().nullish(),
  volume: z.object({ h24: z.number().nullish() }).passthrough().nullish(), priceChange: z.object({ h1: z.number().nullish(), h24: z.number().nullish() }).passthrough().nullish(),
  liquidity: z.object({ usd: z.number().nullish() }).passthrough().nullish(), marketCap: z.number().nullish(), fdv: z.number().nullish(), pairCreatedAt: z.number().nullish(),
  boosts: z.object({ active: z.number().nullish() }).passthrough().nullish(), info: z.object({ websites: z.array(z.unknown()).nullish(), socials: z.array(z.unknown()).nullish() }).passthrough().nullish(),
}).passthrough();

export type MarketMetrics = { symbol: string; name: string; pairAddress: string; dexId: string; volume24hUsd: number | null; liquidityUsd: number | null; mcapUsd: number | null; priceUsd: string | null; priceChange1h: number | null; priceChange24h: number | null; buys24h: number | null; sells24h: number | null; buySellRatio24h: number | null; boosts: number; hasSocials: boolean };

// Picks the post-migration PumpSwap pair, so volume reflects demand after graduating the bonding curve.
export function marketFromPairs(pairs: z.infer<typeof pairSchema>[], mint: string): MarketMetrics | null {
  const own = pairs.filter((pair) => pair.baseToken.address === mint);
  const pair = own.find((item) => item.dexId === "pumpswap") ?? own.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!pair) return null;
  const buys = pair.txns?.h24?.buys ?? null, sells = pair.txns?.h24?.sells ?? null;
  return { symbol: pair.baseToken.symbol, name: pair.baseToken.name, pairAddress: pair.pairAddress, dexId: pair.dexId, volume24hUsd: pair.volume?.h24 ?? null, liquidityUsd: pair.liquidity?.usd ?? null, mcapUsd: pair.marketCap ?? pair.fdv ?? null, priceUsd: pair.priceUsd ?? null, priceChange1h: pair.priceChange?.h1 ?? null, priceChange24h: pair.priceChange?.h24 ?? null, buys24h: buys, sells24h: sells, buySellRatio24h: buys !== null && sells !== null && sells > 0 ? buys / sells : null, boosts: pair.boosts?.active ?? 0, hasSocials: Boolean(pair.info?.websites?.length || pair.info?.socials?.length) };
}

export async function fetchMarkets(mints: string[]) {
  const result = new Map<string, MarketMetrics>();
  for (let offset = 0; offset < mints.length; offset += 30) {
    const batch = mints.slice(offset, offset + 30);
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
    const parsed = z.array(pairSchema).safeParse(await response.json());
    if (!parsed.success) throw new Error("DexScreener response không đúng schema.");
    for (const mint of batch) { const market = marketFromPairs(parsed.data, mint); if (market) result.set(mint, market); }
  }
  return result;
}

const ordersSchema = z.object({ orders: z.array(z.object({ type: z.string(), status: z.string() }).passthrough()) }).passthrough();
// One call answers both flags: an approved tokenProfile order is "DEX paid", an approved communityTakeover is a CTO.
export async function fetchDexFlags(mint: string) {
  const response = await fetch(`https://api.dexscreener.com/orders/v1/solana/${mint}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
  if (!response.ok) throw new Error(`DexScreener orders HTTP ${response.status}`);
  const { orders } = ordersSchema.parse(await response.json());
  const approved = (type: string) => orders.some((order) => order.type === type && order.status === "approved");
  return { dexPaid: approved("tokenProfile"), cto: approved("communityTakeover") };
}

// ---------- On-chain holder concentration (1–2 RPC calls) ----------
export function bondingCurveAddress(mint: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP_PROGRAM)[0].toBase58();
}

// Sum of the 10 largest holders, excluding the AMM pool's vault and the emptied bonding curve.
export function top10FromHolders(holders: Array<{ owner: string | null; amountRaw: string }>, supplyRaw: string, excludedOwners: Set<string>) {
  const supply = BigInt(supplyRaw);
  if (supply === 0n) return null;
  const top = holders.filter((holder) => !holder.owner || !excludedOwners.has(holder.owner)).sort((a, b) => (BigInt(b.amountRaw) > BigInt(a.amountRaw) ? 1 : -1)).slice(0, 10);
  return Number(top.reduce((sum, holder) => sum + BigInt(holder.amountRaw), 0n) * 1_000_000n / supply) / 10_000;
}

export async function fetchTop10Pct(mint: string, poolAddress: string) {
  const rpc = rpcConnection(), key = new PublicKey(mint);
  const [largest, supply] = await Promise.all([rpc.getTokenLargestAccounts(key, "confirmed"), rpc.getTokenSupply(key, "confirmed")]);
  const accounts = await rpc.getMultipleParsedAccounts(largest.value.map((item) => item.address), { commitment: "confirmed" });
  const holders = largest.value.map((item, index) => { const data = accounts.value[index]?.data; return { owner: data && "parsed" in data && typeof data.parsed.info?.owner === "string" ? data.parsed.info.owner as string : null, amountRaw: item.amount }; });
  return { top10Pct: top10FromHolders(holders, supply.value.amount, new Set([poolAddress, bondingCurveAddress(mint)])), supplyRaw: supply.value.amount };
}

// ---------- Helius history (budgeted) ----------
type Balance = { mint?: string; owner?: string; accountIndex?: number; uiTokenAmount?: { amount?: string } };
export type HistoryRecord = { slot?: number; blockTime?: number; meta?: { fee?: number; preTokenBalances?: Balance[]; postTokenBalances?: Balance[]; innerInstructions?: Array<{ instructions?: unknown[] }> } | null; transaction?: { message?: { instructions?: unknown[] } } };

export async function fetchHistoryPage(address: string, options: { limit: number; paginationToken?: string; sortOrder?: "asc" | "desc" }) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY is required for history-based checks.");
  const params: Record<string, unknown> = { transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION, sortOrder: options.sortOrder ?? "asc", limit: options.limit, filters: { status: "succeeded" } };
  if (options.paginationToken) params.paginationToken = options.paginationToken;
  const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(45_000), body: JSON.stringify({ jsonrpc: "2.0", id: "aegis-discovery", method: "getTransactionsForAddress", params: [address, params] }) });
  if (!response.ok) throw new Error(`Helius history HTTP ${response.status}`);
  const payload = await response.json() as { error?: { message?: string }; result?: { data?: HistoryRecord[]; paginationToken?: string } };
  if (payload.error) throw new Error(payload.error.message ?? "Helius history error");
  return { records: payload.result?.data ?? [], paginationToken: payload.result?.paginationToken ?? null };
}

// Helius bills full-transaction history at ~10 credits per 100 transactions (minimum 10).
export const historyCredits = (transactions: number) => Math.max(10, Math.ceil(transactions / 100) * 10);

function ownerBuys(record: HistoryRecord, mint: string, excluded: Set<string>) {
  const pre = new Map((record.meta?.preTokenBalances ?? []).filter((item) => item.mint === mint).map((item) => [item.accountIndex, BigInt(item.uiTokenAmount?.amount ?? "0")]));
  const buys = new Map<string, bigint>();
  for (const balance of record.meta?.postTokenBalances ?? []) {
    if (balance.mint !== mint || !balance.owner || excluded.has(balance.owner)) continue;
    const delta = BigInt(balance.uiTokenAmount?.amount ?? "0") - (pre.get(balance.accountIndex) ?? 0n);
    if (delta > 0n) buys.set(balance.owner, (buys.get(balance.owner) ?? 0n) + delta);
  }
  return buys;
}

// Launch bundle estimate: supply bought in the creation slot, plus slots within the first two after it where
// several distinct wallets bought together. An approximation of what screeners call "bundles"; it measures acquisition, not current holdings.
export function launchBundleFromRecords(records: HistoryRecord[], mint: string, supplyRaw: string, excludedOwners: Set<string>) {
  const ordered = records.filter((record) => typeof record.slot === "number").sort((a, b) => a.slot! - b.slot!);
  if (ordered.length === 0 || BigInt(supplyRaw) === 0n) return null;
  const firstSlot = ordered[0].slot!, perSlot = new Map<number, Map<string, bigint>>();
  for (const record of ordered) {
    if (record.slot! > firstSlot + 2) break;
    const slot = perSlot.get(record.slot!) ?? new Map<string, bigint>();
    for (const [owner, amount] of ownerBuys(record, mint, excludedOwners)) slot.set(owner, (slot.get(owner) ?? 0n) + amount);
    perSlot.set(record.slot!, slot);
  }
  let bundled = 0n; const wallets = new Set<string>();
  for (const [slot, buyers] of perSlot) if (slot === firstSlot || buyers.size >= 2) for (const [owner, amount] of buyers) { bundled += amount; wallets.add(owner); }
  return { bundlePct: Number(bundled * 1_000_000n / BigInt(supplyRaw)) / 10_000, wallets: wallets.size };
}

function tipLamports(instruction: unknown) {
  const parsed = (instruction as { parsed?: { type?: string; info?: { destination?: string; lamports?: number } } } | null)?.parsed;
  return parsed?.type === "transfer" && parsed.info?.destination && JITO_TIP_ACCOUNTS.has(parsed.info.destination) && typeof parsed.info.lamports === "number" ? parsed.info.lamports : 0;
}

// Fees traders paid around this token: network + priority fees plus Jito tips. Other tip services are not counted.
export function feesFromRecords(records: HistoryRecord[]) {
  let lamports = 0;
  for (const record of records) {
    lamports += record.meta?.fee ?? 0;
    for (const instruction of [...(record.transaction?.message?.instructions ?? []), ...(record.meta?.innerInstructions?.flatMap((group) => group.instructions ?? []) ?? [])]) lamports += tipLamports(instruction);
  }
  return lamports;
}

export async function fetchLaunchBundle(mint: string, supplyRaw: string, poolAddress: string) {
  const { records } = await fetchHistoryPage(mint, { limit: 200, sortOrder: "asc" });
  return { result: launchBundleFromRecords(records, mint, supplyRaw, new Set([poolAddress, bondingCurveAddress(mint)])), credits: historyCredits(records.length) };
}

// Pages through history until the target is reached or the page cap; below target with pages left is only a lower bound.
export async function fetchTotalFees(mint: string, stopAtSol: number, maxPages: number) {
  let lamports = 0, credits = 0, token: string | undefined, pages = 0, complete = false;
  while (pages < maxPages) {
    const page = await fetchHistoryPage(mint, { limit: 1000, paginationToken: token, sortOrder: "desc" });
    pages++; credits += historyCredits(page.records.length); lamports += feesFromRecords(page.records);
    if (!page.paginationToken) { complete = true; break; }
    if (lamports / 1e9 > stopAtSol) break;
    token = page.paginationToken;
  }
  const sol = lamports / 1e9;
  return { totalFeesSol: complete ? sol : { lowerBound: sol }, credits, pages, complete };
}
