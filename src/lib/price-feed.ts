import { z } from "zod";

const responseSchema = z.record(z.string(), z.object({ usdPrice: z.number() }).passthrough());

export function jupiterHeaders() {
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.JUPITER_API_KEY) headers["x-api-key"] = process.env.JUPITER_API_KEY;
  return headers;
}

// USD prices from Jupiter Price API v3. Tokens without a reliable price are omitted by the API.
// Prices are floats and only used to decide when to fetch an exact quote, never for accounting.
export async function fetchJupiterPrices(mints: string[]) {
  const prices = new Map<string, number>(), unique = [...new Set(mints)];
  for (let offset = 0; offset < unique.length; offset += 50) {
    const url = new URL(process.env.JUPITER_PRICE_URL ?? "https://api.jup.ag/price/v3");
    url.searchParams.set("ids", unique.slice(offset, offset + 50).join(","));
    const response = await fetch(url, { headers: jupiterHeaders(), signal: AbortSignal.timeout(8_000), cache: "no-store" });
    if (!response.ok) throw new Error(`Jupiter price HTTP ${response.status}`);
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Jupiter price response không đúng schema.");
    for (const [mint, item] of Object.entries(parsed.data)) if (Number.isFinite(item.usdPrice) && item.usdPrice > 0) prices.set(mint, item.usdPrice);
  }
  return prices;
}
