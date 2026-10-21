import {
  confirmLiveEntry,
  confirmLiveExit,
  failLiveExit,
  getCandidateDetail,
  getLivePortfolioState,
  getShadowPortfolioState,
  getShadowSettings,
  getTradingControls,
  listEligibleMints,
  listOpenLivePositions,
  listOpenShadowPositions,
  markLiveOrderFailed,
  markLiveOrderSubmitted,
  reserveLiveEntry,
  reserveLiveExit,
  savePositionMark,
  saveShadowEntry,
  saveShadowExit,
} from "@/db/repository";
import { executeLiveSwap, liveTradingConfigError, WSOL_MINT } from "./live";
import { assessPortfolioRisk, assessShadowEntry } from "./strategy";
import type { Candidate } from "./types";
import { sendAlertOnce } from "./alerts";

export type JupiterQuote = { inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold?: string; swapMode?: string; slippageBps?: number; priceImpactPct?: string; routePlan?: unknown[]; [key: string]: unknown };

export async function getJupiterQuote(inputMint: string, outputMint: string, amountRaw: string, slippageBps = Number(process.env.SHADOW_SLIPPAGE_BPS ?? 300)): Promise<JupiterQuote> {
  const url = new URL(process.env.JUPITER_QUOTE_URL ?? "https://lite-api.jup.ag/swap/v1/quote");
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amountRaw);
  url.searchParams.set("slippageBps", String(slippageBps));
  url.searchParams.set("restrictIntermediateTokens", "true");
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Jupiter quote HTTP ${response.status}`);
  const quote = await response.json() as JupiterQuote & { error?: string };
  if (quote.error || !quote.outAmount || !quote.inAmount) throw new Error(quote.error ?? "Jupiter quote khong hop le.");
  return quote;
}

export const getShadowQuote = (outputMint: string, amountLamports = Number(process.env.SHADOW_ENTRY_LAMPORTS ?? 50_000_000), slippageBps = Number(process.env.SHADOW_SLIPPAGE_BPS ?? 300)) => getJupiterQuote(WSOL_MINT, outputMint, String(amountLamports), slippageBps);

function candidateFromDetail(mint: string, detail: NonNullable<Awaited<ReturnType<typeof getCandidateDetail>>>): Candidate {
  return {
    mint,
    symbol: detail.token.symbol,
    name: detail.token.name,
    launchpad: detail.token.launchpad === "Pump.fun" || detail.token.launchpad === "BONK" ? detail.token.launchpad : "Unknown",
    migratedHours: detail.migration ? Math.max(0, (Date.now() - detail.migration.blockTime.getTime()) / 3_600_000) : null,
    riskScore: detail.token.riskScore,
    bundlePct: detail.risk?.suspectedBundlePct === null || detail.risk?.suspectedBundlePct === undefined ? null : Number(detail.risk.suspectedBundlePct),
    clusterPct: detail.risk?.creatorClusterPct === null || detail.risk?.creatorClusterPct === undefined ? null : Number(detail.risk.creatorClusterPct),
    liquidityUsd: detail.pool?.liquidityUsd ? Number(detail.pool.liquidityUsd) : null,
    volume1hUsd: detail.pool?.volume1hUsd ? Number(detail.pool.volume1hUsd) : null,
    priceChange1h: detail.pool?.priceChange1h ? Number(detail.pool.priceChange1h) : null,
    status: detail.token.status,
  };
}

export async function executeShadowEntry(mint: string) {
  const detail = await getCandidateDetail(mint);
  if (!detail || detail.token.status !== "eligible" || !detail.risk) return { mint, skipped: true, reason: "Token chua eligible." };
  const settings = await getShadowSettings();
  const portfolio = assessPortfolioRisk(await getShadowPortfolioState(mint), settings);
  if (!portfolio.accepted) {
    const reason = portfolio.reasons.join(" ");
    void sendAlertOnce(`portfolio:${mint}:${reason}`, 15 * 60_000, { type: "portfolio.entry.blocked", severity: "warning", title: "Shadow entry blocked", message: `${mint}: ${reason}`, data: { mint, reasons: portfolio.reasons } });
    return { mint, skipped: true, reason };
  }
  const quote = await getShadowQuote(mint, settings.entryLamports, settings.slippageBps);
  const decision = assessShadowEntry(candidateFromDetail(mint, detail), quote, settings);
  if (!decision.accepted) return { mint, skipped: true, reason: decision.reasons.join(" "), score: decision.score };
  const saved = await saveShadowEntry(mint, detail.risk.id, quote, decision);
  if (saved && !saved.duplicate) void sendAlertOnce(`entry:${saved.orderId}`, 24 * 60 * 60_000, { type: "shadow.entry.simulated", severity: "info", title: `Shadow entry ${detail.token.symbol}`, message: `Simulated buy ${quote.inAmount} lamports.`, data: { mint, orderId: saved.orderId, positionId: saved.positionId, score: decision.score } });
  return { mint, skipped: saved?.duplicate ?? false, orderId: saved?.orderId ?? null, positionId: saved?.positionId ?? null, outAmount: quote.outAmount };
}

export async function executeLiveEntry(mint: string) {
  const detail = await getCandidateDetail(mint);
  if (!detail || detail.token.status !== "eligible" || !detail.risk) return { mint, skipped: true, reason: "Token chua eligible." };
  const settings = await getShadowSettings();
  const portfolio = assessPortfolioRisk(await getLivePortfolioState(mint), settings);
  if (!portfolio.accepted) return { mint, skipped: true, reason: portfolio.reasons.join(" ") };
  const quote = await getShadowQuote(mint, settings.entryLamports, settings.slippageBps);
  const decision = assessShadowEntry(candidateFromDetail(mint, detail), quote, settings);
  if (!decision.accepted) return { mint, skipped: true, reason: decision.reasons.join(" "), score: decision.score };
  const reserved = await reserveLiveEntry(mint, detail.risk.id, quote, decision);
  if (!reserved || reserved.duplicate || !reserved.orderId) return { mint, skipped: true, reason: "Live entry da duoc reserve hoac dang co lenh/vithe.", orderId: reserved?.orderId ?? null };
  try {
    const execution = await executeLiveSwap(quote, signature => markLiveOrderSubmitted(reserved.orderId!, signature).then(() => undefined));
    const saved = await confirmLiveEntry(reserved.orderId, mint, quote, execution);
    if (saved && !saved.duplicate) void sendAlertOnce(`live-entry:${execution.signature}`, 24 * 60 * 60_000, { type: "live.entry.confirmed", severity: "critical", title: `LIVE entry ${detail.token.symbol}`, message: `Bought with ${quote.inAmount} lamports.`, data: { mint, signature: execution.signature, orderId: saved.orderId, positionId: saved.positionId, score: decision.score } });
    return { mint, skipped: false, orderId: saved?.orderId ?? reserved.orderId, positionId: saved?.positionId ?? null, signature: execution.signature, outAmount: execution.outputDeltaRaw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markLiveOrderFailed(reserved.orderId, message);
    void sendAlertOnce(`live-entry-failed:${reserved.orderId}`, 60 * 60_000, { type: "live.entry.failed", severity: "critical", title: `LIVE entry failed ${mint.slice(0, 6)}`, message, data: { mint, orderId: reserved.orderId } });
    return { mint, skipped: true, orderId: reserved.orderId, reason: message };
  }
}

export async function executeShadowScan() {
  const mode = process.env.TRADING_MODE ?? "paper";
  if (mode === "live") return executeLiveScan();
  if (mode !== "shadow") return { skipped: true, reason: "TRADING_MODE chua dat la shadow hoac live.", results: [] };
  const exits = await executeShadowExits();
  const controls = await getTradingControls();
  if (controls.entriesPaused) return { skipped: false, entriesPaused: true, reason: controls.reason, exits, entries: [] };
  const exitedMints = new Set(exits.filter(item => item.closed).map(item => item.mint));
  const entries = [];
  for (const mint of await listEligibleMints()) {
    if (exitedMints.has(mint)) continue;
    try { entries.push(await executeShadowEntry(mint)); } catch (error) { entries.push({ mint, skipped: true, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return { skipped: false, exits, entries };
}

export async function executeLiveScan() {
  const configError = liveTradingConfigError();
  if (configError) return { skipped: true, reason: configError, exits: [], entries: [] };
  const exits = await executeLiveExits();
  const controls = await getTradingControls();
  if (controls.entriesPaused) return { skipped: false, entriesPaused: true, reason: controls.reason, exits, entries: [] };
  const exitedMints = new Set(exits.filter(item => item.closed).map(item => item.mint));
  const entries = [];
  for (const mint of await listEligibleMints()) {
    if (exitedMints.has(mint)) continue;
    try { entries.push(await executeLiveEntry(mint)); } catch (error) { entries.push({ mint, skipped: true, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return { skipped: false, exits, entries };
}

export async function executeShadowExits() {
  const settings = await getShadowSettings();
  const results = [];
  for (const position of await listOpenShadowPositions()) {
    try {
      const quote = await getJupiterQuote(position.mint, WSOL_MINT, position.quantityRaw, settings.slippageBps);
      const value = BigInt(quote.outAmount);
      const cost = BigInt(position.costLamports);
      const pnlBps = cost === 0n ? 0 : Number((value - cost) * 10_000n / cost);
      const ageMinutes = (Date.now() - position.openedAt.getTime()) / 60_000;
      await savePositionMark(position.id, quote, pnlBps);
      const reason = decideShadowExit({ tokenStatus: position.tokenStatus, pnlBps, ageMinutes, stopLossBps: settings.stopLossBps, takeProfitBps: settings.takeProfitBps, maxAgeMinutes: settings.maxPositionMinutes });
      if (!reason) { results.push({ mint: position.mint, positionId: position.id, closed: false, pnlBps }); continue; }
      const saved = await saveShadowExit(position.id, position.mint, quote, reason, pnlBps);
      if (saved && !saved.duplicate) void sendAlertOnce(`exit:${position.id}`, 24 * 60 * 60_000, { type: "shadow.exit.simulated", severity: reason === "risk_exit" || reason === "stop_loss" ? "warning" : "info", title: `Shadow exit ${position.mint.slice(0, 6)}`, message: `${reason}, PnL ${(pnlBps / 100).toFixed(2)}%.`, data: { mint: position.mint, positionId: position.id, orderId: saved.orderId, reason, pnlBps } });
      results.push({ mint: position.mint, positionId: position.id, closed: true, reason, pnlBps });
    } catch (error) { results.push({ mint: position.mint, positionId: position.id, closed: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

export async function executeLiveExits() {
  const settings = await getShadowSettings();
  const results = [];
  for (const position of await listOpenLivePositions()) {
    try {
      const quote = await getJupiterQuote(position.mint, WSOL_MINT, position.quantityRaw, settings.slippageBps);
      const value = BigInt(quote.outAmount);
      const cost = BigInt(position.costLamports);
      const pnlBps = cost === 0n ? 0 : Number((value - cost) * 10_000n / cost);
      const ageMinutes = (Date.now() - position.openedAt.getTime()) / 60_000;
      await savePositionMark(position.id, quote, pnlBps);
      const reason = decideShadowExit({ tokenStatus: position.tokenStatus, pnlBps, ageMinutes, stopLossBps: settings.stopLossBps, takeProfitBps: settings.takeProfitBps, maxAgeMinutes: settings.maxPositionMinutes });
      if (!reason) { results.push({ mint: position.mint, positionId: position.id, closed: false, pnlBps }); continue; }
      const reserved = await reserveLiveExit(position.id, position.mint, quote, reason, pnlBps);
      if (!reserved || reserved.duplicate || !reserved.orderId) { results.push({ mint: position.mint, positionId: position.id, closed: false, reason: "Exit da duoc reserve." }); continue; }
      try {
        const execution = await executeLiveSwap(quote, signature => markLiveOrderSubmitted(reserved.orderId!, signature).then(() => undefined));
        const saved = await confirmLiveExit(position.id, position.mint, reserved.orderId, quote, reason, pnlBps, execution);
        void sendAlertOnce(`live-exit:${execution.signature}`, 24 * 60 * 60_000, { type: "live.exit.confirmed", severity: reason === "risk_exit" || reason === "stop_loss" ? "critical" : "warning", title: `LIVE exit ${position.mint.slice(0, 6)}`, message: `${reason}, PnL ${(pnlBps / 100).toFixed(2)}%.`, data: { mint: position.mint, positionId: position.id, orderId: saved?.orderId ?? reserved.orderId, signature: execution.signature, reason, pnlBps } });
        results.push({ mint: position.mint, positionId: position.id, closed: true, reason, pnlBps, signature: execution.signature });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failLiveExit(position.id, reserved.orderId, message);
        results.push({ mint: position.mint, positionId: position.id, closed: false, reason, error: message });
      }
    } catch (error) { results.push({ mint: position.mint, positionId: position.id, closed: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

export function decideShadowExit(input: { tokenStatus: string; pnlBps: number; ageMinutes: number; stopLossBps: number; takeProfitBps: number; maxAgeMinutes: number }) {
  return input.tokenStatus !== "eligible" ? "risk_exit" : input.pnlBps <= input.stopLossBps ? "stop_loss" : input.pnlBps >= input.takeProfitBps ? "take_profit" : input.ageMinutes >= input.maxAgeMinutes ? "time_stop" : null;
}
