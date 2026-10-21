import { z } from "zod";

const tokenSchema = z.object({ address: z.string(), name: z.string(), symbol: z.string() });
const pairSchema = z.object({
  chainId: z.string(), dexId: z.string(), pairAddress: z.string(), labels: z.array(z.string()).nullish(),
  baseToken: tokenSchema, quoteToken: tokenSchema, priceUsd: z.string().nullish(),
  volume: z.object({ h1: z.number().nullish(), h24: z.number().nullish() }).passthrough().nullish(),
  priceChange: z.object({ h1: z.number().nullish() }).passthrough().nullish(),
  liquidity: z.object({ usd: z.number().nullish() }).passthrough().nullish(),
  pairCreatedAt: z.number().nullish(),
});

export type MarketInspection = {
  name: string; symbol: string; launchpad: "Pump.fun" | "BONK" | "Unknown";
  poolAddress: string; dex: string; quoteMint: string;
  liquidityUsd: number | null; volume1hUsd: number | null; volume24hUsd: number | null;
  priceChange1h: number | null; pairCreatedAt: Date | null;
  // Decimal string as returned by DexScreener; stored exactly in numeric columns.
  priceUsd: string | null;
};

export async function inspectMarket(mint: string): Promise<MarketInspection | null> {
  const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(mint)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000), cache: "no-store" });
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  const parsed = z.array(pairSchema).safeParse(await response.json());
  if (!parsed.success) throw new Error("DexScreener response không đúng schema.");
  const pairs = parsed.data.filter((pair) => pair.chainId === "solana" && (pair.baseToken.address === mint || pair.quoteToken.address === mint));
  const pair = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!pair) return null;
  const token = pair.baseToken.address === mint ? pair.baseToken : pair.quoteToken;
  const quote = pair.baseToken.address === mint ? pair.quoteToken : pair.baseToken;
  const labels = (pair.labels ?? []).map((label) => label.toLowerCase());
  const launchpad = mint.toLowerCase().endsWith("pump") || pair.dexId.toLowerCase() === "pumpswap" ? "Pump.fun" : labels.some((label) => label.includes("bonk")) ? "BONK" : "Unknown";
  return { name: token.name.trim() || "Token chưa nhận diện", symbol: token.symbol.trim() || "—", launchpad, poolAddress: pair.pairAddress, dex: pair.dexId, quoteMint: quote.address, liquidityUsd: pair.liquidity?.usd ?? null, volume1hUsd: pair.volume?.h1 ?? null, volume24hUsd: pair.volume?.h24 ?? null, priceChange1h: pair.priceChange?.h1 ?? null, pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null, priceUsd: pair.baseToken.address === mint && pair.priceUsd && /^\d+(\.\d+)?$/.test(pair.priceUsd) ? pair.priceUsd : null };
}
