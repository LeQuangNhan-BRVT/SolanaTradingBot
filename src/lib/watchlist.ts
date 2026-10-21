import { z } from "zod";

const decimal = z.string().trim().regex(/^\d+(\.\d{1,18})?$/, "Giá phải là số thập phân dương, tối đa 18 chữ số thập phân.");

export const watchlistPatchSchema = z.object({
  note: z.string().trim().max(500).nullable().optional(),
  tags: z.array(z.string()).max(10).optional(),
  pinned: z.boolean().optional(),
  // Restoring goes through POST /api/candidates so the token is re-verified and its jobs rescheduled.
  archived: z.literal(true).optional(),
  autoTrade: z.boolean().optional(),
  alertPriceAboveUsd: decimal.nullable().optional(),
  alertPriceBelowUsd: decimal.nullable().optional(),
  alertChange1hPct: z.number().positive().max(10_000).nullable().optional(),
}).strict();

export type WatchlistPatch = z.infer<typeof watchlistPatchSchema>;

export function normalizeTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-")).filter((tag) => tag.length > 0 && tag.length <= 24))].slice(0, 10);
}

const SCALE = 18;
function toScaled(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(SCALE, "0").slice(0, SCALE));
}
export const compareDecimal = (a: string, b: string) => { const x = toScaled(a), y = toScaled(b); return x === y ? 0 : x > y ? 1 : -1; };

export type WatchAlertConfig = { mint: string; symbol: string; alertPriceAboveUsd: string | null; alertPriceBelowUsd: string | null; alertChange1hPct: string | null };
export type WatchAlert = { kind: "price_above" | "price_below" | "change_1h"; message: string };

export function evaluateWatchAlerts(config: WatchAlertConfig, market: { priceUsd: string | null; priceChange1h: number | null }): WatchAlert[] {
  const alerts: WatchAlert[] = [];
  if (market.priceUsd !== null) {
    if (config.alertPriceAboveUsd !== null && compareDecimal(market.priceUsd, config.alertPriceAboveUsd) >= 0) alerts.push({ kind: "price_above", message: `${config.symbol} giá $${market.priceUsd} ≥ ngưỡng $${config.alertPriceAboveUsd}.` });
    if (config.alertPriceBelowUsd !== null && compareDecimal(market.priceUsd, config.alertPriceBelowUsd) <= 0) alerts.push({ kind: "price_below", message: `${config.symbol} giá $${market.priceUsd} ≤ ngưỡng $${config.alertPriceBelowUsd}.` });
  }
  if (config.alertChange1hPct !== null && market.priceChange1h !== null && Math.abs(market.priceChange1h) >= Number(config.alertChange1hPct)) alerts.push({ kind: "change_1h", message: `${config.symbol} biến động ${market.priceChange1h.toFixed(2)}% trong 1h (ngưỡng ±${config.alertChange1hPct}%).` });
  return alerts;
}
