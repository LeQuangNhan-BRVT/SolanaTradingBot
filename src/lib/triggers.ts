import { z } from "zod";
import type { JupiterQuote } from "./shadow";

// Permanent rejection: the order can never fill as configured (e.g. its position is gone), so it is not retried.
export class TriggerRejectedError extends Error {}

export type TriggerType ="limit_buy" | "take_profit" | "stop_loss" | "trailing_stop";
export const TRIGGER_LABELS: Record<TriggerType, string> = { limit_buy: "Limit mua", take_profit: "Take profit", stop_loss: "Stop loss", trailing_stop: "Trailing stop" };

// Accepts "5M", "1.2b", "750k", "1,500,000" or "$2.5M". Returns USD or null.
export function parseMcapInput(input: string) {
  const match = input.trim().replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!match) return null;
  const value = Number(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase() as "k" | "m" | "b"] ?? 1);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function formatMcap(value: number | string | null | undefined) {
  const n = value === null || value === undefined ? NaN : Number(value);
  if (!Number.isFinite(n)) return "—";
  return n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
}

// Market cap = price × total supply. Supply is the on-chain raw supply, so burned tokens are already excluded.
export function mcapFromPrice(priceUsd: number, supplyRaw: string, decimals: number) {
  return priceUsd * Number(supplyRaw) / 10 ** decimals;
}

// Exact conversion of a decimal SOL string (up to 9 decimals) to lamports.
export function solToLamports(input: string) {
  const match = input.trim().match(/^(\d+)(?:\.(\d{1,9}))?$/);
  if (!match) return null;
  const lamports = BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(9, "0") || "0");
  return lamports > 0n ? lamports : null;
}

export type TriggerState = { type: TriggerType; triggerMcapUsd: number | null; trailingBps: number | null; peakMcapUsd: number | null };

// Trailing stops track the highest market cap seen since creation and fire after a drop of trailingBps from that peak.
export function evaluateTrigger(order: TriggerState, mcapUsd: number) {
  if (order.type === "trailing_stop") {
    const peak = Math.max(order.peakMcapUsd ?? mcapUsd, mcapUsd);
    return { fire: order.trailingBps !== null && mcapUsd <= peak * (1 - order.trailingBps / 10_000), peakMcapUsd: peak };
  }
  if (order.triggerMcapUsd === null) return { fire: false, peakMcapUsd: order.peakMcapUsd };
  const fire = order.type === "take_profit" ? mcapUsd >= order.triggerMcapUsd : mcapUsd <= order.triggerMcapUsd;
  return { fire, peakMcapUsd: order.peakMcapUsd };
}

// Execution price implied by a quote, expressed as market cap. Buy quotes are SOL -> token, sell quotes token -> SOL.
export function impliedMcapFromQuote(quote: Pick<JupiterQuote, "inAmount" | "outAmount">, side: "buy" | "sell", decimals: number, supplyRaw: string, solUsd: number) {
  const lamports = Number(side === "buy" ? quote.inAmount : quote.outAmount), tokens = Number(side === "buy" ? quote.outAmount : quote.inAmount) / 10 ** decimals;
  if (!(tokens > 0)) return null;
  return mcapFromPrice(lamports / 1e9 * solUsd / tokens, supplyRaw, decimals);
}

// Limits fill only at their price or better; stops fill at market but refuse quotes with excessive price impact.
export function confirmTriggerQuote(order: { type: TriggerType; triggerMcapUsd: number | null; maxSlippageBps: number }, impliedMcapUsd: number | null, priceImpactPct: string | undefined) {
  const impactBps = Math.round(Number(priceImpactPct ?? "0") * 10_000);
  if (impactBps > order.maxSlippageBps) return { ok: false, reason: `Price impact ${(impactBps / 100).toFixed(2)}% vượt giới hạn ${(order.maxSlippageBps / 100).toFixed(2)}%.` };
  if (impliedMcapUsd === null) return { ok: false, reason: "Quote không suy ra được giá khớp." };
  if (order.type === "limit_buy" && order.triggerMcapUsd !== null && impliedMcapUsd > order.triggerMcapUsd) return { ok: false, reason: `Giá khớp ${formatMcap(impliedMcapUsd)} cao hơn limit ${formatMcap(order.triggerMcapUsd)}.` };
  if (order.type === "take_profit" && order.triggerMcapUsd !== null && impliedMcapUsd < order.triggerMcapUsd) return { ok: false, reason: `Giá khớp ${formatMcap(impliedMcapUsd)} thấp hơn take profit ${formatMcap(order.triggerMcapUsd)}.` };
  return { ok: true, reason: null };
}

export function sellAmountRaw(quantityRaw: string, sellPctBps: number) {
  const quantity = BigInt(quantityRaw);
  return sellPctBps >= 10_000 ? quantity : quantity * BigInt(sellPctBps) / 10_000n;
}

// Cost basis released by a partial sell, proportional to the quantity sold.
export function costPortion(costLamports: string, quantityRaw: string, soldRaw: bigint) {
  const quantity = BigInt(quantityRaw);
  return soldRaw >= quantity ? BigInt(costLamports) : BigInt(costLamports) * soldRaw / quantity;
}

const common = { mint: z.string().trim().min(32).max(44), maxSlippageBps: z.number().int().min(10).max(2_000).default(300), expiresInHours: z.number().positive().max(720).nullable().optional() };
const sellPct = z.number().min(1).max(100);
export const createTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("limit_buy"), triggerMcapUsd: z.number().positive(), buySol: z.string().trim(), ...common }).strict(),
  z.object({ type: z.literal("take_profit"), triggerMcapUsd: z.number().positive(), sellPct, ...common }).strict(),
  z.object({ type: z.literal("stop_loss"), triggerMcapUsd: z.number().positive(), sellPct, ...common }).strict(),
  z.object({ type: z.literal("trailing_stop"), trailingPct: z.number().min(1).max(90), sellPct, ...common }).strict(),
  z.object({ type: z.literal("bracket"), takeProfitMcapUsd: z.number().positive(), stopLossMcapUsd: z.number().positive(), sellPct, ...common }).strict(),
]);
export type CreateTriggerInput = z.infer<typeof createTriggerSchema>;

// Rejects orders that would fire immediately; there is no instant market order in this engine.
export function validateAgainstMarket(input: CreateTriggerInput, currentMcapUsd: number) {
  const errors: string[] = [];
  if (input.type === "limit_buy" && input.triggerMcapUsd >= currentMcapUsd) errors.push(`Limit mua phải thấp hơn market cap hiện tại ${formatMcap(currentMcapUsd)}.`);
  if (input.type === "take_profit" && input.triggerMcapUsd <= currentMcapUsd) errors.push(`Take profit phải cao hơn market cap hiện tại ${formatMcap(currentMcapUsd)}.`);
  if (input.type === "stop_loss" && input.triggerMcapUsd >= currentMcapUsd) errors.push(`Stop loss phải thấp hơn market cap hiện tại ${formatMcap(currentMcapUsd)}.`);
  if (input.type === "bracket") {
    if (input.takeProfitMcapUsd <= currentMcapUsd) errors.push(`Take profit phải cao hơn market cap hiện tại ${formatMcap(currentMcapUsd)}.`);
    if (input.stopLossMcapUsd >= currentMcapUsd) errors.push(`Stop loss phải thấp hơn market cap hiện tại ${formatMcap(currentMcapUsd)}.`);
  }
  return errors;
}
