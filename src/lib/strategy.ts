import type { Candidate } from "./types";
import type { JupiterQuote } from "./shadow";
import type { ShadowSettings } from "./settings";

export type EntryDecision = { accepted: boolean; score: number; reasons: string[]; metrics: Record<string, number | null> };

export function assessShadowEntry(candidate: Candidate, quote: JupiterQuote, settings?: ShadowSettings): EntryDecision {
  const liquidity = candidate.liquidityUsd ?? 0, volume = candidate.volume1hUsd ?? 0, momentum = candidate.priceChange1h, volumeLiquidity = liquidity > 0 ? volume / liquidity : 0, impactPct = Number(quote.priceImpactPct ?? "1") * 100;
  let score = 30; const reasons: string[] = [];
  score += Math.min(25, Math.round(volumeLiquidity * 20));
  if (momentum !== null && momentum >= 0 && momentum <= 40) score += 20; else if (momentum !== null && momentum > 40 && momentum <= 80) score += 8; else reasons.push("Momentum ngoài vùng ưu tiên 0–40%.");
  score += Math.min(15, Math.round(liquidity / 20_000));
  if ((candidate.bundlePct ?? 100) <= 5) score += 5;
  if ((candidate.clusterPct ?? 100) <= 2.5) score += 5;
  score += Math.max(0, 20 - Math.round(impactPct * 4));
  score = Math.min(100, score);
  const minimumScore = settings?.minSignalScore ?? Number(process.env.SHADOW_MIN_SIGNAL_SCORE ?? 70), maximumImpact = settings?.maxPriceImpactPct ?? Number(process.env.SHADOW_MAX_PRICE_IMPACT_PCT ?? 5);
  if (volumeLiquidity < (settings?.minVolumeLiquidity ?? Number(process.env.SHADOW_MIN_VOLUME_LIQUIDITY ?? 0.25))) reasons.push("Volume/liquidity ratio quá thấp.");
  if (impactPct > maximumImpact) reasons.push(`Price impact ${impactPct.toFixed(2)}% vượt giới hạn ${maximumImpact}%.`);
  if (score < minimumScore) reasons.push(`Signal score ${score} thấp hơn ngưỡng ${minimumScore}.`);
  return { accepted: reasons.length === 0, score, reasons, metrics: { liquidityUsd: candidate.liquidityUsd, volume1hUsd: candidate.volume1hUsd, volumeLiquidity, momentum1h: momentum, priceImpactPct: impactPct, bundlePct: candidate.bundlePct, clusterPct: candidate.clusterPct, riskScore: candidate.riskScore } };
}

export type PortfolioState = { openCount: number; exposureLamports: string; dailyRealizedPnlLamports: string; consecutiveLosses: number; lastClosedAt: Date | null };
export function assessPortfolioRisk(state: PortfolioState, settings?: ShadowSettings) {
  const reasons: string[] = [], maxOpen = settings?.maxOpenPositions ?? Number(process.env.SHADOW_MAX_OPEN_POSITIONS ?? 3), maxExposure = BigInt(settings?.maxExposureLamports ?? process.env.SHADOW_MAX_EXPOSURE_LAMPORTS ?? "150000000"), dailyLoss = BigInt(settings?.dailyLossLimitLamports ?? process.env.SHADOW_DAILY_LOSS_LIMIT_LAMPORTS ?? "-50000000"), maxLosses = settings?.maxConsecutiveLosses ?? Number(process.env.SHADOW_MAX_CONSECUTIVE_LOSSES ?? 3), cooldown = settings?.reentryCooldownMinutes ?? Number(process.env.SHADOW_REENTRY_COOLDOWN_MINUTES ?? 60);
  if (state.openCount >= maxOpen) reasons.push(`Đã đạt giới hạn ${maxOpen} vị thế mở.`);
  if (BigInt(state.exposureLamports) + BigInt(settings?.entryLamports ?? process.env.SHADOW_ENTRY_LAMPORTS ?? "50000000") > maxExposure) reasons.push("Tổng exposure vượt giới hạn.");
  if (BigInt(state.dailyRealizedPnlLamports) <= dailyLoss) reasons.push("Đã chạm daily loss limit.");
  if (state.consecutiveLosses >= maxLosses) reasons.push(`Đã có ${state.consecutiveLosses} lệnh thua liên tiếp.`);
  if (state.lastClosedAt && Date.now() - state.lastClosedAt.getTime() < cooldown * 60_000) reasons.push(`Token đang trong cooldown ${cooldown} phút.`);
  return { accepted: reasons.length === 0, reasons };
}
