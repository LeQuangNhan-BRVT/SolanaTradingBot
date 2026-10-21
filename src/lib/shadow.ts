import {
  confirmLiveEntry,
  confirmLiveExit,
  failLiveOrder,
  getCandidateDetail,
  getLivePortfolioState,
  getLiveSpentTodayLamports,
  getShadowPortfolioState,
  getShadowSettings,
  getTradingControls,
  listEligibleMints,
  listOpenLivePositions,
  listOpenShadowPositions,
  markLiveOrderPrepared,
  markLiveOrderSent,
  reserveLiveEntry,
  reserveLiveExit,
  savePositionMark,
  saveShadowEntry,
  saveShadowExit,
} from "@/db/repository";
import { withRedisLock } from "@/queue/client";
import { executeLiveSwap, liveConnection, liveTradingConfigError, loadLiveKeypair, LiveSwapFailedError, type LiveSide, type LiveSwapExecution, WSOL_MINT } from "./live";
import { assessLiveEntryLimits, liveLimitsFromEnv } from "./live-safety";
import { jupiterHeaders } from "./price-feed";
import type { ShadowSettings } from "./settings";
import { assessPortfolioRisk, assessShadowEntry } from "./strategy";
import type { Candidate } from "./types";
import { sendAlertOnce } from "./alerts";

export type JupiterQuote = { inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold?: string; swapMode?: string; slippageBps?: number; priceImpactPct?: string; routePlan?: unknown[]; [key: string]: unknown };

export async function getJupiterQuote(inputMint: string, outputMint: string, amountRaw: string, slippageBps = Number(process.env.SHADOW_SLIPPAGE_BPS ?? 300)): Promise<JupiterQuote> {
  const url = new URL(process.env.JUPITER_QUOTE_URL ?? "https://api.jup.ag/swap/v1/quote");
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amountRaw);
  url.searchParams.set("slippageBps", String(slippageBps));
  url.searchParams.set("restrictIntermediateTokens", "true");
  const response = await fetch(url, { headers: jupiterHeaders(), signal: AbortSignal.timeout(20_000) });
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

// Re-read right before broadcasting so a kill switch flipped mid-scan still stops the send.
export async function assertLiveSendAllowed(side: LiveSide) {
  const controls = await getTradingControls();
  if (controls.haltAll) throw new Error(`Live trading halted: ${controls.reason ?? "no reason given"}.`);
  if (side === "buy" && controls.entriesPaused) throw new Error(`Live entries paused: ${controls.reason ?? "no reason given"}.`);
}

// Runs one live swap for a reserved order and records the outcome. Unknown outcomes stay pending for the recovery job.
async function runLiveOrder(orderId: string, quote: JupiterQuote, side: LiveSide): Promise<{ execution: LiveSwapExecution } | { error: string; pending: boolean }> {
  try {
    const execution = await executeLiveSwap(quote, side, { beforeSend: async (prepared) => { await assertLiveSendAllowed(side); await markLiveOrderPrepared(orderId, prepared); }, afterSend: async () => { await markLiveOrderSent(orderId); } });
    return { execution };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof LiveSwapFailedError) { await failLiveOrder(orderId, message); return { error: message, pending: false }; }
    void sendAlertOnce(`live-pending:${orderId}`, 60 * 60_000, { type: "live.order.pending", severity: "warning", title: "LIVE order pending recovery", message, data: { orderId, side } });
    return { error: message, pending: true };
  }
}

async function liveWalletLamports() {
  try { return BigInt(await liveConnection().getBalance(loadLiveKeypair().publicKey, "confirmed")); } catch { return null; }
}

export async function executeLiveEntry(mint: string) {
  const detail = await getCandidateDetail(mint);
  if (!detail || detail.token.status !== "eligible" || !detail.risk) return { mint, skipped: true, reason: "Token chua eligible." };
  const settings = await getShadowSettings();
  const portfolio = assessPortfolioRisk(await getLivePortfolioState(mint), settings);
  if (!portfolio.accepted) return { mint, skipped: true, reason: portfolio.reasons.join(" ") };
  const limits = assessLiveEntryLimits({ entryLamports: BigInt(settings.entryLamports), spentTodayLamports: await getLiveSpentTodayLamports(), walletLamports: await liveWalletLamports() }, liveLimitsFromEnv());
  if (!limits.accepted) {
    const reason = limits.reasons.join(" ");
    void sendAlertOnce(`live-limits:${reason}`, 60 * 60_000, { type: "live.entry.limited", severity: "warning", title: "LIVE entry blocked by hard cap", message: `${mint}: ${reason}`, data: { mint, reasons: limits.reasons } });
    return { mint, skipped: true, reason };
  }
  const quote = await getShadowQuote(mint, settings.entryLamports, settings.slippageBps);
  const decision = assessShadowEntry(candidateFromDetail(mint, detail), quote, settings);
  if (!decision.accepted) return { mint, skipped: true, reason: decision.reasons.join(" "), score: decision.score };
  const reserved = await reserveLiveEntry(mint, detail.risk.id, quote, decision);
  if (!reserved || reserved.duplicate || !reserved.orderId) return { mint, skipped: true, reason: "Live entry da duoc reserve hoac dang co lenh/vithe.", orderId: reserved?.orderId ?? null };
  const result = await runLiveOrder(reserved.orderId, quote, "buy");
  if ("error" in result) {
    if (!result.pending) void sendAlertOnce(`live-entry-failed:${reserved.orderId}`, 60 * 60_000, { type: "live.entry.failed", severity: "critical", title: `LIVE entry failed ${mint.slice(0, 6)}`, message: result.error, data: { mint, orderId: reserved.orderId } });
    return { mint, skipped: true, orderId: reserved.orderId, reason: result.error, pending: result.pending };
  }
  const saved = await confirmLiveEntry(reserved.orderId, result.execution);
  if (saved && !saved.duplicate) void sendAlertOnce(`live-entry:${result.execution.signature}`, 24 * 60 * 60_000, { type: "live.entry.confirmed", severity: "critical", title: `LIVE entry ${detail.token.symbol}`, message: `Spent ${result.execution.lamports} lamports (fee ${result.execution.feeLamports}).`, data: { mint, signature: result.execution.signature, orderId: saved.orderId, positionId: saved.positionId, score: decision.score } });
  return { mint, skipped: false, orderId: reserved.orderId, positionId: saved?.positionId ?? null, signature: result.execution.signature, tokenAmountRaw: result.execution.tokenAmountRaw };
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
  // Serializes live scans so two overlapping jobs cannot both pass the reservation checks.
  const result = await withRedisLock("live-scan", 600, async () => {
    const controls = await getTradingControls();
    if (controls.haltAll) return { skipped: true, halted: true, reason: controls.reason, exits: [], entries: [] };
    const exits = await executeLiveExits();
    if (controls.entriesPaused) return { skipped: false, entriesPaused: true, reason: controls.reason, exits, entries: [] };
    const exitedMints = new Set(exits.filter(item => item.closed).map(item => item.mint));
    const entries = [];
    for (const mint of await listEligibleMints()) {
      if (exitedMints.has(mint)) continue;
      try { entries.push(await executeLiveEntry(mint)); } catch (error) { entries.push({ mint, skipped: true, reason: error instanceof Error ? error.message : String(error) }); }
    }
    return { skipped: false, exits, entries };
  });
  return result ?? { skipped: true, reason: "Another live scan is running.", exits: [], entries: [] };
}

type OpenPosition = Awaited<ReturnType<typeof listOpenShadowPositions>>[number];

async function markAndDecide(position: OpenPosition, settings: ShadowSettings) {
  const quote = await getJupiterQuote(position.mint, WSOL_MINT, position.quantityRaw, settings.slippageBps);
  const cost = BigInt(position.costLamports);
  const pnlBps = cost === 0n ? 0 : Number((BigInt(quote.outAmount) - cost) * 10_000n / cost);
  await savePositionMark(position.id, quote, pnlBps);
  const reason = decideShadowExit({ tokenStatus: position.tokenStatus, pnlBps, ageMinutes: (Date.now() - position.openedAt.getTime()) / 60_000, stopLossBps: settings.stopLossBps, takeProfitBps: settings.takeProfitBps, maxAgeMinutes: settings.maxPositionMinutes });
  return { quote, pnlBps, reason };
}

async function exitShadowPosition(position: OpenPosition, settings: ShadowSettings) {
  try {
    const { quote, pnlBps, reason } = await markAndDecide(position, settings);
    if (!reason) return { mint: position.mint, positionId: position.id, closed: false, pnlBps };
    const saved = await saveShadowExit(position.id, position.mint, quote, reason, pnlBps);
    if (saved && !saved.duplicate) void sendAlertOnce(`exit:${position.id}`, 24 * 60 * 60_000, { type: "shadow.exit.simulated", severity: reason === "risk_exit" || reason === "stop_loss" ? "warning" : "info", title: `Shadow exit ${position.mint.slice(0, 6)}`, message: `${reason}, PnL ${(pnlBps / 100).toFixed(2)}%.`, data: { mint: position.mint, positionId: position.id, orderId: saved.orderId, reason, pnlBps } });
    return { mint: position.mint, positionId: position.id, closed: true, reason, pnlBps };
  } catch (error) { return { mint: position.mint, positionId: position.id, closed: false, error: error instanceof Error ? error.message : String(error) }; }
}

async function exitLivePosition(position: OpenPosition, settings: ShadowSettings) {
  try {
    const { quote, pnlBps, reason } = await markAndDecide(position, settings);
    if (!reason) return { mint: position.mint, positionId: position.id, closed: false, pnlBps };
    const reserved = await reserveLiveExit(position.id, position.mint, quote, reason, pnlBps);
    if (!reserved || reserved.duplicate || !reserved.orderId) return { mint: position.mint, positionId: position.id, closed: false, reason: "Exit da duoc reserve." };
    const result = await runLiveOrder(reserved.orderId, quote, "sell");
    if ("error" in result) return { mint: position.mint, positionId: position.id, closed: false, reason, error: result.error, pending: result.pending };
    const saved = await confirmLiveExit(reserved.orderId, result.execution);
    void sendAlertOnce(`live-exit:${result.execution.signature}`, 24 * 60 * 60_000, { type: "live.exit.confirmed", severity: reason === "risk_exit" || reason === "stop_loss" ? "critical" : "warning", title: `LIVE exit ${position.mint.slice(0, 6)}`, message: `${reason}, received ${result.execution.lamports} lamports, realized ${saved?.realizedPnlLamports ?? "?"} lamports.`, data: { mint: position.mint, positionId: position.id, orderId: reserved.orderId, signature: result.execution.signature, reason, quotedPnlBps: pnlBps } });
    return { mint: position.mint, positionId: position.id, closed: true, reason, pnlBps, signature: result.execution.signature };
  } catch (error) { return { mint: position.mint, positionId: position.id, closed: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function executeShadowExits() {
  const settings = await getShadowSettings(), results = [];
  for (const position of await listOpenShadowPositions()) results.push(await exitShadowPosition(position, settings));
  return results;
}

export async function executeLiveExits() {
  const settings = await getShadowSettings(), results = [];
  for (const position of await listOpenLivePositions()) results.push(await exitLivePosition(position, settings));
  return results;
}

// Triggered by the fast price loop for a single position that is near a stop-loss or take-profit threshold.
export async function executeExitCheck(mode: "shadow" | "live", positionId: string) {
  const settings = await getShadowSettings();
  if (mode === "shadow") {
    const position = (await listOpenShadowPositions()).find((item) => item.id === positionId);
    return position ? exitShadowPosition(position, settings) : { positionId, closed: false, skipped: true };
  }
  if (liveTradingConfigError()) return { positionId, closed: false, skipped: true, reason: liveTradingConfigError() };
  if ((await getTradingControls()).haltAll) return { positionId, closed: false, skipped: true, reason: "halted" };
  const position = (await listOpenLivePositions()).find((item) => item.id === positionId);
  return position ? exitLivePosition(position, settings) : { positionId, closed: false, skipped: true };
}

export function decideShadowExit(input: { tokenStatus: string; pnlBps: number; ageMinutes: number; stopLossBps: number; takeProfitBps: number; maxAgeMinutes: number }) {
  return input.tokenStatus !== "eligible" ? "risk_exit" : input.pnlBps <= input.stopLossBps ? "stop_loss" : input.pnlBps >= input.takeProfitBps ? "take_profit" : input.ageMinutes >= input.maxAgeMinutes ? "time_stop" : null;
}
