import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDatabase, hasDatabase } from "./client";
import { auditLogs, bundleAssessments, fills, holderBalances, holderSnapshots, migrationEvents, orders, pools, positionMarks, positions, riskAssessments, runtimeSettings, signals, tokenCreators, tokens, trackedWallets, triggerOrders, walletFundingEdges, wallets } from "./schema";
import { normalizeTags, type WatchAlertConfig, type WatchlistPatch } from "@/lib/watchlist";
import { costPortion, TriggerRejectedError } from "@/lib/triggers";
import type { Candidate, MintInspection, RiskCheck } from "@/lib/types";
import type { MarketInspection } from "@/lib/market";
import type { MigrationInspection } from "@/lib/migration";
import type { CreatorInspection } from "@/lib/creator";
import type { HolderGraph } from "@/lib/graph";
import type { BundleAssessment } from "@/lib/bundle";
import type { JupiterQuote } from "@/lib/shadow";
import type { LiveSwapExecution, PreparedSwap } from "@/lib/live";
import type { EntryDecision, PortfolioState } from "@/lib/strategy";
import { defaultShadowSettings, type ShadowSettings } from "@/lib/settings";

export async function saveHolderGraph(mint:string,graph:HolderGraph){if(!hasDatabase())return null;return getDatabase().transaction(async tx=>{const [token]=await tx.select({id:tokens.id}).from(tokens).where(eq(tokens.mint,mint)).limit(1);if(!token)throw new Error("Token chưa tồn tại.");const [snapshot]=await tx.insert(holderSnapshots).values({tokenId:token.id,slot:graph.slot,supplyRaw:graph.supplyRaw,creatorClusterPct:graph.creatorClusterPct?.toString()??null}).returning({id:holderSnapshots.id});for(const node of graph.holders){let walletId:string|null=null;if(node.owner!=="unknown"){const [wallet]=await tx.insert(wallets).values({address:node.owner}).onConflictDoUpdate({target:wallets.address,set:{updatedAt:new Date()}}).returning({id:wallets.id});walletId=wallet.id}await tx.insert(holderBalances).values({snapshotId:snapshot.id,walletId,tokenAccount:node.tokenAccount,rank:node.rank,amountRaw:node.amountRaw,percentage:node.percentage.toString(),excluded:node.excluded,exclusionReason:node.exclusionReason});if(node.funding&&walletId){const [source]=await tx.insert(wallets).values({address:node.funding.from}).onConflictDoUpdate({target:wallets.address,set:{updatedAt:new Date()}}).returning({id:wallets.id});await tx.insert(walletFundingEdges).values({fromWalletId:source.id,toWalletId:walletId,signature:node.funding.signature,lamports:node.funding.lamports,slot:node.funding.slot,blockTime:node.funding.blockTime}).onConflictDoNothing()}}return{snapshotId:snapshot.id,creatorClusterPct:graph.creatorClusterPct}})}

export async function saveBundleAssessment(mint: string, holderSnapshotId: string, result: BundleAssessment) {
  if (!hasDatabase()) return null;
  const db = getDatabase();
  const [token] = await db.select({ id: tokens.id }).from(tokens).where(eq(tokens.mint, mint)).limit(1);
  if (!token) throw new Error("Token chưa tồn tại.");
  const [assessment] = await db.insert(bundleAssessments).values({ tokenId: token.id, holderSnapshotId, suspectedBundlePct: result.suspectedBundlePct.toString(), confidence: result.confidence, coveredTransactions: result.coveredTransactions, truncated: result.truncated, suspiciousWallets: result.suspiciousWallets, evidence: result.evidence }).returning({ id: bundleAssessments.id });
  return assessment;
}

export async function saveFinalRiskAssessment(mint: string, candidate: Candidate, checks: RiskCheck[]) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    const [token] = await tx.select({ id: tokens.id }).from(tokens).where(eq(tokens.mint, mint)).limit(1);
    if (!token) throw new Error("Token chưa tồn tại.");
    const [versionRow] = await tx.select({ next: sql<number>`coalesce(max(${riskAssessments.version}), 0) + 1` }).from(riskAssessments).where(eq(riskAssessments.tokenId, token.id));
    const [assessment] = await tx.insert(riskAssessments).values({ tokenId: token.id, version: Number(versionRow.next), status: candidate.status, score: candidate.riskScore, creatorClusterPct: candidate.clusterPct?.toString(), suspectedBundlePct: candidate.bundlePct?.toString(), checks }).returning({ id: riskAssessments.id });
    await tx.update(tokens).set({ status: candidate.status, riskScore: candidate.riskScore, updatedAt: new Date() }).where(eq(tokens.id, token.id));
    await tx.insert(auditLogs).values({ eventType: "risk.finalized", entityType: "token", entityId: token.id, payload: { mint, assessmentId: assessment.id, status: candidate.status, score: candidate.riskScore } });
    return assessment;
  });
}

export async function refreshCandidateMarket(mint: string, market: MarketInspection) {
  if (!hasDatabase()) return null;
  const db = getDatabase();
  const [token] = await db.update(tokens).set({ symbol: market.symbol, name: market.name, launchpad: market.launchpad, updatedAt: new Date() }).where(eq(tokens.mint, mint)).returning({ id: tokens.id });
  if (!token) throw new Error("Token chưa tồn tại trong database.");
  const [pool] = await db.insert(pools).values({ tokenId: token.id, address: market.poolAddress, dex: market.dex, quoteMint: market.quoteMint, liquidityUsd: market.liquidityUsd?.toString(), volume1hUsd: market.volume1hUsd?.toString(), volume24hUsd: market.volume24hUsd?.toString(), priceChange1h: market.priceChange1h?.toString(), priceUsd: market.priceUsd, pairCreatedAt: market.pairCreatedAt, verified: false, updatedAt: new Date() }).onConflictDoUpdate({ target: pools.address, set: { liquidityUsd: market.liquidityUsd?.toString(), volume1hUsd: market.volume1hUsd?.toString(), volume24hUsd: market.volume24hUsd?.toString(), priceChange1h: market.priceChange1h?.toString(), priceUsd: market.priceUsd, pairCreatedAt: market.pairCreatedAt, updatedAt: new Date() } }).returning({ id: pools.id });
  return { tokenId: token.id, poolId: pool.id };
}

export async function listCandidates(options: { archived?: boolean } = {}): Promise<Candidate[]> {
  if (!hasDatabase()) return [];
  const db = getDatabase();
  const rows = await db.select().from(tokens).where(options.archived ? isNotNull(tokens.archivedAt) : isNull(tokens.archivedAt)).orderBy(desc(tokens.pinned), desc(tokens.updatedAt)).limit(200);
  return Promise.all(rows.map(async (row) => {
    const [pool] = await db.select().from(pools).where(eq(pools.tokenId, row.id)).orderBy(desc(pools.liquidityUsd)).limit(1);
    const [risk] = await db.select().from(riskAssessments).where(eq(riskAssessments.tokenId, row.id)).orderBy(desc(riskAssessments.version)).limit(1);
    const [migration] = await db.select().from(migrationEvents).where(and(eq(migrationEvents.tokenId, row.id), eq(migrationEvents.verified, true))).orderBy(desc(migrationEvents.blockTime)).limit(1);
    const [creatorRow] = await db.select({ address: wallets.address }).from(tokenCreators).innerJoin(wallets, eq(tokenCreators.creatorWalletId, wallets.id)).where(eq(tokenCreators.tokenId, row.id)).limit(1);
    const migratedHours = migration ? Math.max(0, (Date.now() - migration.blockTime.getTime()) / 3_600_000) : null;
    return { mint: row.mint, symbol: row.symbol, name: row.name, launchpad: row.launchpad === "Pump.fun" || row.launchpad === "BONK" ? row.launchpad : "Unknown", migratedHours, riskScore: row.riskScore, bundlePct: risk?.suspectedBundlePct === null || risk?.suspectedBundlePct === undefined ? null : Number(risk.suspectedBundlePct), clusterPct: risk?.creatorClusterPct === null || risk?.creatorClusterPct === undefined ? null : Number(risk.creatorClusterPct), liquidityUsd: pool?.liquidityUsd ? Number(pool.liquidityUsd) : null, volume1hUsd: pool?.volume1hUsd ? Number(pool.volume1hUsd) : null, priceChange1h: pool?.priceChange1h ? Number(pool.priceChange1h) : null, status: row.status, creator: creatorRow?.address ?? null, priceUsd: pool?.priceUsd ?? null, watch: { note: row.watchNote, tags: row.watchTags, pinned: row.pinned, archived: row.archivedAt !== null, autoTrade: row.autoTrade } };
  }));
}

export class WatchlistError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export async function updateWatchlist(mint: string, patch: WatchlistPatch) {
  if (!hasDatabase()) throw new WatchlistError("Database chưa được cấu hình.", 503);
  return getDatabase().transaction(async (tx) => {
    const [token] = await tx.select({ id: tokens.id, archivedAt: tokens.archivedAt }).from(tokens).where(eq(tokens.mint, mint)).limit(1);
    if (!token) throw new WatchlistError("Không tìm thấy token.", 404);
    if (patch.archived === true && token.archivedAt === null) {
      // Archiving stops market and holder refresh, so open positions would lose their risk exit signal.
      const [open] = await tx.select({ id: positions.id }).from(positions).where(and(eq(positions.tokenId, token.id), inArray(positions.status, ["open", "closing"]))).limit(1);
      if (open) throw new WatchlistError("Token đang có vị thế mở; hãy đóng vị thế trước khi lưu trữ.", 409);
    }
    const values: Partial<typeof tokens.$inferInsert> = { updatedAt: new Date() };
    if (patch.note !== undefined) values.watchNote = patch.note || null;
    if (patch.tags !== undefined) values.watchTags = normalizeTags(patch.tags);
    if (patch.pinned !== undefined) values.pinned = patch.pinned;
    if (patch.autoTrade !== undefined) values.autoTrade = patch.autoTrade;
    if (patch.archived !== undefined) { values.archivedAt = patch.archived ? token.archivedAt ?? new Date() : null; if (patch.archived) { values.autoTrade = false; values.pinned = false; } }
    if (patch.alertPriceAboveUsd !== undefined) values.alertPriceAboveUsd = patch.alertPriceAboveUsd;
    if (patch.alertPriceBelowUsd !== undefined) values.alertPriceBelowUsd = patch.alertPriceBelowUsd;
    if (patch.alertChange1hPct !== undefined) values.alertChange1hPct = patch.alertChange1hPct === null ? null : patch.alertChange1hPct.toString();
    const [row] = await tx.update(tokens).set(values).where(eq(tokens.id, token.id)).returning();
    await tx.insert(auditLogs).values({ eventType: "watchlist.updated", entityType: "token", entityId: token.id, payload: { mint, patch } });
    return row;
  });
}

export async function isTokenArchived(mint: string) {
  if (!hasDatabase()) return false;
  const [row] = await getDatabase().select({ archivedAt: tokens.archivedAt }).from(tokens).where(eq(tokens.mint, mint)).limit(1);
  return Boolean(row?.archivedAt);
}

export async function getWatchAlertConfig(mint: string): Promise<WatchAlertConfig | null> {
  if (!hasDatabase()) return null;
  const [row] = await getDatabase().select({ mint: tokens.mint, symbol: tokens.symbol, alertPriceAboveUsd: tokens.alertPriceAboveUsd, alertPriceBelowUsd: tokens.alertPriceBelowUsd, alertChange1hPct: tokens.alertChange1hPct }).from(tokens).where(eq(tokens.mint, mint)).limit(1);
  return row ?? null;
}

export async function listWatchedMints(mints: string[]) {
  if (!hasDatabase() || mints.length === 0) return new Map<string, { archived: boolean }>();
  const rows = await getDatabase().select({ mint: tokens.mint, archivedAt: tokens.archivedAt }).from(tokens).where(inArray(tokens.mint, mints));
  return new Map(rows.map((row) => [row.mint, { archived: row.archivedAt !== null }]));
}

export async function listTrackedWallets() {
  if (!hasDatabase()) return [];
  return getDatabase().select().from(trackedWallets).orderBy(desc(trackedWallets.createdAt));
}

export async function getTrackedWallet(address: string) {
  if (!hasDatabase()) return null;
  const [row] = await getDatabase().select().from(trackedWallets).where(eq(trackedWallets.address, address)).limit(1);
  return row ?? null;
}

// preserveLabel: used when a connected browser wallet auto-registers, so a label the user chose is not overwritten.
export async function saveTrackedWallet(address: string, label: string | null, preserveLabel = false) {
  if (!hasDatabase()) throw new Error("Database chưa được cấu hình.");
  const db = getDatabase();
  if (preserveLabel) { await db.insert(trackedWallets).values({ address, label }).onConflictDoNothing(); return (await db.select().from(trackedWallets).where(eq(trackedWallets.address, address)).limit(1))[0]; }
  const [row] = await db.insert(trackedWallets).values({ address, label }).onConflictDoUpdate({ target: trackedWallets.address, set: { label, updatedAt: new Date() } }).returning();
  return row;
}

export async function deleteTrackedWallet(address: string) {
  if (!hasDatabase()) return false;
  const rows = await getDatabase().delete(trackedWallets).where(eq(trackedWallets.address, address)).returning({ id: trackedWallets.id });
  return rows.length > 0;
}

export async function getCandidateDetail(mint: string) {
  if (!hasDatabase()) return null;
  const db = getDatabase();
  const [token] = await db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1);
  if (!token) return null;
  const [pool] = await db.select().from(pools).where(eq(pools.tokenId, token.id)).orderBy(desc(pools.liquidityUsd)).limit(1);
  const [migration] = await db.select().from(migrationEvents).where(and(eq(migrationEvents.tokenId, token.id), eq(migrationEvents.verified, true))).orderBy(desc(migrationEvents.blockTime)).limit(1);
  const [creator] = await db.select({ address: wallets.address, signature: tokenCreators.signature, blockTime: tokenCreators.blockTime }).from(tokenCreators).innerJoin(wallets, eq(tokenCreators.creatorWalletId, wallets.id)).where(eq(tokenCreators.tokenId, token.id)).limit(1);
  const [risk] = await db.select().from(riskAssessments).where(eq(riskAssessments.tokenId, token.id)).orderBy(desc(riskAssessments.version)).limit(1);
  const [snapshot] = await db.select().from(holderSnapshots).where(eq(holderSnapshots.tokenId, token.id)).orderBy(desc(holderSnapshots.capturedAt)).limit(1);
  const [bundle] = await db.select().from(bundleAssessments).where(eq(bundleAssessments.tokenId, token.id)).orderBy(desc(bundleAssessments.assessedAt)).limit(1);
  const holders = snapshot ? await db.select({ rank: holderBalances.rank, tokenAccount: holderBalances.tokenAccount, owner: wallets.address, amountRaw: holderBalances.amountRaw, percentage: holderBalances.percentage, excluded: holderBalances.excluded, exclusionReason: holderBalances.exclusionReason, walletId: holderBalances.walletId }).from(holderBalances).leftJoin(wallets, eq(holderBalances.walletId, wallets.id)).where(eq(holderBalances.snapshotId, snapshot.id)).orderBy(holderBalances.rank) : [];
  const holderDetails = await Promise.all(holders.map(async (holder) => {
    if (!holder.walletId) return { ...holder, funding: null };
    const [edge] = await db.select().from(walletFundingEdges).where(eq(walletFundingEdges.toWalletId, holder.walletId)).orderBy(desc(walletFundingEdges.blockTime)).limit(1);
    if (!edge) return { ...holder, funding: null };
    const [source] = await db.select({ address: wallets.address }).from(wallets).where(eq(wallets.id, edge.fromWalletId)).limit(1);
    return { ...holder, funding: { from: source?.address ?? null, signature: edge.signature, lamports: edge.lamports, blockTime: edge.blockTime } };
  }));
  return { token, pool: pool ?? null, migration: migration ?? null, creator: creator ?? null, risk: risk ?? null, snapshot: snapshot ?? null, bundle: bundle ?? null, holders: holderDetails };
}

export async function listEligibleMints() {
  if (!hasDatabase()) return [];
  // Automated entries are opt-in per token: eligibility alone never authorizes a trade.
  const rows = await getDatabase().select({ mint: tokens.mint }).from(tokens).where(and(eq(tokens.status, "eligible"), eq(tokens.autoTrade, true), isNull(tokens.archivedAt)));
  return rows.map((row) => row.mint);
}

export async function saveShadowEntry(mint: string, riskAssessmentId: string, quote: JupiterQuote, decision: EntryDecision) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    const [token] = await tx.select({ id: tokens.id, status: tokens.status }).from(tokens).where(eq(tokens.mint, mint)).limit(1);
    if (!token || token.status !== "eligible") throw new Error("Token không còn eligible.");
    const [openPosition] = await tx.select({ id: positions.id }).from(positions).where(and(eq(positions.tokenId, token.id), eq(positions.mode, "shadow"), eq(positions.status, "open"))).limit(1);
    if (openPosition) return { duplicate: true as const, orderId: null, positionId: openPosition.id };
    const idempotencyKey = `shadow-entry:v2:${token.id}:${riskAssessmentId}:${quote.inAmount}`;
    const [signal] = await tx.insert(signals).values({ tokenId: token.id, riskAssessmentId, strategyVersion: "shadow-v2", idempotencyKey, score: decision.score.toString(), payload: { reason: "strategy_accepted", quoteSource: "jupiter", inputMint: quote.inputMint, outputMint: quote.outputMint, metrics: decision.metrics } }).onConflictDoNothing().returning({ id: signals.id });
    if (!signal) return { duplicate: true as const, orderId: null, positionId: null };
    const [order] = await tx.insert(orders).values({ signalId: signal.id, tokenId: token.id, mode: "shadow", side: "buy", status: "simulated", idempotencyKey, requestedAmountRaw: quote.inAmount, quoteRaw: quote }).returning({ id: orders.id });
    const [position] = await tx.insert(positions).values({ tokenId: token.id, mode: "shadow", status: "open", quantityRaw: quote.outAmount, costLamports: quote.inAmount }).returning({ id: positions.id });
    await tx.insert(auditLogs).values({ eventType: "shadow.entry.simulated", entityType: "order", entityId: order.id, payload: { mint, positionId: position.id, inputLamports: quote.inAmount, outputAmountRaw: quote.outAmount, priceImpactPct: quote.priceImpactPct ?? null } });
    return { duplicate: false as const, orderId: order.id, positionId: position.id };
  });
}

export async function reserveLiveEntry(mint: string, riskAssessmentId: string, quote: JupiterQuote, decision: EntryDecision) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    const [token] = await tx.select({ id: tokens.id, status: tokens.status }).from(tokens).where(eq(tokens.mint, mint)).limit(1);
    if (!token || token.status !== "eligible") throw new Error("Token khong con eligible.");
    const [openPosition] = await tx.select({ id: positions.id }).from(positions).where(and(eq(positions.tokenId, token.id), eq(positions.mode, "live"), sql`${positions.status} in ('open','closing')`)).limit(1);
    if (openPosition) return { duplicate: true as const, orderId: null, positionId: openPosition.id };
    const [pendingOrder] = await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.tokenId, token.id), eq(orders.mode, "live"), eq(orders.side, "buy"), sql`${orders.status} in ('created','quoted','simulated','submitted')`)).limit(1);
    if (pendingOrder) return { duplicate: true as const, orderId: pendingOrder.id, positionId: null };
    const idempotencyKey = `live-entry:v1:${token.id}:${riskAssessmentId}:${quote.inAmount}:${Math.floor(Date.now() / 60_000)}`;
    const [signal] = await tx.insert(signals).values({ tokenId: token.id, riskAssessmentId, strategyVersion: "live-v1", idempotencyKey, score: decision.score.toString(), payload: { reason: "strategy_accepted", quoteSource: "jupiter", inputMint: quote.inputMint, outputMint: quote.outputMint, metrics: decision.metrics } }).onConflictDoNothing().returning({ id: signals.id });
    if (!signal) return { duplicate: true as const, orderId: null, positionId: null };
    const [order] = await tx.insert(orders).values({ signalId: signal.id, tokenId: token.id, mode: "live", side: "buy", status: "quoted", idempotencyKey, requestedAmountRaw: quote.inAmount, quoteRaw: quote }).returning({ id: orders.id });
    await tx.insert(auditLogs).values({ eventType: "live.entry.reserved", entityType: "order", entityId: order.id, payload: { mint, inputLamports: quote.inAmount, expectedOutputAmountRaw: quote.outAmount, score: decision.score } });
    return { duplicate: false as const, orderId: order.id, positionId: null };
  });
}

// Persists the signed transaction's signature and expiry before broadcast so a crash can always be recovered.
export async function markLiveOrderPrepared(orderId: string, prepared: PreparedSwap) {
  if (!hasDatabase()) throw new Error("Database chưa cấu hình.");
  const [order] = await getDatabase().update(orders).set({ status: "simulated", signature: prepared.signature, wallet: prepared.wallet, lastValidBlockHeight: prepared.lastValidBlockHeight, updatedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.status, "quoted"))).returning({ id: orders.id });
  if (!order) throw new Error(`Live order ${orderId} is no longer reserved.`);
  return order;
}

export async function markLiveOrderSent(orderId: string) {
  if (!hasDatabase()) return null;
  const [order] = await getDatabase().update(orders).set({ status: "submitted", sentAt: new Date(), updatedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.status, "simulated"))).returning({ id: orders.id });
  return order ?? null;
}

const PENDING_LIVE_STATUSES = ["quoted", "simulated", "submitted"] as const;

// Closes out an order that definitively did not execute; a failed sell returns its position to open so exits retry.
export async function failLiveOrder(orderId: string, error: string) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    const [order] = await tx.update(orders).set({ status: "failed", error: error.slice(0, 2_000), updatedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.mode, "live"), inArray(orders.status, [...PENDING_LIVE_STATUSES]))).returning({ id: orders.id, side: orders.side, tokenId: orders.tokenId });
    if (!order) return null;
    if (order.side === "sell") await tx.update(positions).set({ status: "open", updatedAt: new Date() }).where(and(eq(positions.tokenId, order.tokenId), eq(positions.mode, "live"), eq(positions.status, "closing")));
    await tx.insert(auditLogs).values({ eventType: "live.order.failed", entityType: "order", entityId: order.id, payload: { side: order.side, error: error.slice(0, 500) } });
    return order;
  });
}

// Idempotent: only the first caller (live path, manual submit or recovery job) moves the order to confirmed and records the position.
export async function confirmLiveEntry(orderId: string, execution: LiveSwapExecution) {
  if (!hasDatabase()) return null;
  if (BigInt(execution.tokenAmountRaw) <= 0n) throw new Error("Live entry token amount is zero.");
  return getDatabase().transaction(async (tx) => {
    const [order] = await tx.update(orders).set({ status: "confirmed", signature: execution.signature, updatedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.mode, "live"), eq(orders.side, "buy"), inArray(orders.status, [...PENDING_LIVE_STATUSES]))).returning({ id: orders.id, tokenId: orders.tokenId, quoteRaw: orders.quoteRaw, origin: orders.origin });
    if (!order) return { duplicate: true as const, orderId, positionId: null };
    await tx.update(orders).set({ quoteRaw: { ...(order.quoteRaw ?? {}), execution } }).where(eq(orders.id, order.id));
    await tx.insert(fills).values({ orderId: order.id, signature: execution.signature, baseAmountRaw: execution.tokenAmountRaw, quoteAmountRaw: execution.lamports, feeLamports: execution.feeLamports, slot: execution.slot === null ? null : BigInt(execution.slot), filledAt: execution.blockTime ?? new Date() }).onConflictDoNothing();
    // Manual buys into a token the wallet already holds through the app add to that position (cost averaging).
    const [existing] = order.origin === "manual" ? await tx.select().from(positions).where(and(eq(positions.tokenId, order.tokenId), eq(positions.mode, "live"), eq(positions.origin, "manual"), eq(positions.wallet, execution.wallet), eq(positions.status, "open"))).for("update") : [];
    const position = existing
      ? (await tx.update(positions).set({ quantityRaw: (BigInt(existing.quantityRaw) + BigInt(execution.tokenAmountRaw)).toString(), costLamports: (BigInt(existing.costLamports) + BigInt(execution.lamports)).toString(), updatedAt: new Date() }).where(eq(positions.id, existing.id)).returning({ id: positions.id }))[0]
      : (await tx.insert(positions).values({ tokenId: order.tokenId, mode: "live", status: "open", origin: order.origin, wallet: execution.wallet, quantityRaw: execution.tokenAmountRaw, costLamports: execution.lamports }).returning({ id: positions.id }))[0];
    await tx.insert(auditLogs).values({ eventType: "live.entry.confirmed", entityType: "order", entityId: order.id, payload: { mint: execution.tokenMint, positionId: position.id, origin: order.origin, addedToExisting: Boolean(existing), signature: execution.signature, costLamports: execution.lamports, feeLamports: execution.feeLamports, tokenAmountRaw: execution.tokenAmountRaw, wallet: execution.wallet } });
    return { duplicate: false as const, orderId: order.id, positionId: position.id };
  });
}

export async function getShadowPortfolioState(mint: string): Promise<PortfolioState> {
  if (!hasDatabase()) return { openCount: 0, exposureLamports: "0", dailyRealizedPnlLamports: "0", consecutiveLosses: 0, lastClosedAt: null };
  const db = getDatabase();
  const [open] = await db.select({ count: sql<number>`count(*)::int`, exposure: sql<string>`coalesce(sum(${positions.costLamports}),0)::text` }).from(positions).where(and(eq(positions.mode,"shadow"),eq(positions.status,"open")));
  const [daily] = await db.select({ pnl: sql<string>`coalesce(sum(${positions.realizedPnlLamports}),0)::text` }).from(positions).where(and(eq(positions.mode,"shadow"),eq(positions.status,"closed"),sql`${positions.closedAt} >= date_trunc('day', now())`));
  const recent = await db.select({ pnl: positions.realizedPnlLamports }).from(positions).where(and(eq(positions.mode,"shadow"),eq(positions.status,"closed"))).orderBy(desc(positions.closedAt)).limit(20);
  let consecutiveLosses=0; for(const item of recent){if(BigInt(item.pnl)<0n)consecutiveLosses++;else break;}
  const [last] = await db.select({ closedAt: positions.closedAt }).from(positions).innerJoin(tokens,eq(positions.tokenId,tokens.id)).where(and(eq(tokens.mint,mint),eq(positions.mode,"shadow"),eq(positions.status,"closed"))).orderBy(desc(positions.closedAt)).limit(1);
  return { openCount: open?.count??0, exposureLamports: open?.exposure??"0", dailyRealizedPnlLamports: daily?.pnl??"0", consecutiveLosses, lastClosedAt: last?.closedAt??null };
}

export async function getLivePortfolioState(mint: string): Promise<PortfolioState> {
  if (!hasDatabase()) return { openCount: 0, exposureLamports: "0", dailyRealizedPnlLamports: "0", consecutiveLosses: 0, lastClosedAt: null };
  const db = getDatabase();
  const [open] = await db.select({ count: sql<number>`count(*)::int`, exposure: sql<string>`coalesce(sum(${positions.costLamports}),0)::text` }).from(positions).where(and(eq(positions.mode,"live"),eq(positions.origin,"auto"),eq(positions.status,"open")));
  const [daily] = await db.select({ pnl: sql<string>`coalesce(sum(${positions.realizedPnlLamports}),0)::text` }).from(positions).where(and(eq(positions.mode,"live"),eq(positions.origin,"auto"),eq(positions.status,"closed"),sql`${positions.closedAt} >= date_trunc('day', now())`));
  const recent = await db.select({ pnl: positions.realizedPnlLamports }).from(positions).where(and(eq(positions.mode,"live"),eq(positions.origin,"auto"),eq(positions.status,"closed"))).orderBy(desc(positions.closedAt)).limit(20);
  let consecutiveLosses=0; for(const item of recent){if(BigInt(item.pnl)<0n)consecutiveLosses++;else break;}
  const [last] = await db.select({ closedAt: positions.closedAt }).from(positions).innerJoin(tokens,eq(positions.tokenId,tokens.id)).where(and(eq(tokens.mint,mint),eq(positions.mode,"live"),eq(positions.origin,"auto"),eq(positions.status,"closed"))).orderBy(desc(positions.closedAt)).limit(1);
  return { openCount: open?.count??0, exposureLamports: open?.exposure??"0", dailyRealizedPnlLamports: daily?.pnl??"0", consecutiveLosses, lastClosedAt: last?.closedAt??null };
}

export async function listOpenShadowPositions() {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: positions.id, mint: tokens.mint, tokenStatus: tokens.status, quantityRaw: positions.quantityRaw, costLamports: positions.costLamports, openedAt: positions.openedAt }).from(positions).innerJoin(tokens, eq(positions.tokenId, tokens.id)).where(and(eq(positions.mode, "shadow"), eq(positions.status, "open"), eq(positions.origin, "auto")));
}

export async function listOpenLivePositions() {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: positions.id, mint: tokens.mint, tokenStatus: tokens.status, quantityRaw: positions.quantityRaw, costLamports: positions.costLamports, openedAt: positions.openedAt }).from(positions).innerJoin(tokens, eq(positions.tokenId, tokens.id)).where(and(eq(positions.mode, "live"), eq(positions.status, "open"), eq(positions.origin, "auto")));
}

export async function savePositionMark(positionId: string, quote: JupiterQuote, pnlBps: number) {
  if (!hasDatabase()) return null;
  const db = getDatabase(); const [position] = await db.select({ costLamports: positions.costLamports }).from(positions).where(and(eq(positions.id, positionId), eq(positions.status, "open"))).limit(1);
  if (!position) return null; const unrealized = (BigInt(quote.outAmount) - BigInt(position.costLamports)).toString();
  const [mark] = await db.insert(positionMarks).values({ positionId, valueLamports: quote.outAmount, unrealizedPnlLamports: unrealized, pnlBps, quoteRaw: quote }).returning({ id: positionMarks.id }); return mark;
}

export async function reserveLiveExit(positionId: string, mint: string, quote: JupiterQuote, reason: string, pnlBps: number) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    // The conditional open -> closing transition is the double-exit guard, so each retry after a failure gets a fresh key.
    const [position] = await tx.update(positions).set({ status: "closing", updatedAt: new Date() }).where(and(eq(positions.id, positionId), eq(positions.mode, "live"), eq(positions.status, "open"))).returning();
    if (!position) return { duplicate: true as const, orderId: null };
    const idempotencyKey = `live-exit:${position.id}:${Date.now()}`;
    const [order] = await tx.insert(orders).values({ tokenId: position.tokenId, mode: "live", side: "sell", status: "quoted", idempotencyKey, requestedAmountRaw: position.quantityRaw, quoteRaw: { ...quote, exitReason: reason, pnlBps } }).onConflictDoNothing().returning({ id: orders.id });
    // Throwing rolls back the closing transition so the position is not stranded.
    if (!order) throw new Error(`Live exit order for ${position.id} could not be reserved.`);
    await tx.insert(auditLogs).values({ eventType: "live.exit.reserved", entityType: "order", entityId: order.id, payload: { mint, positionId, reason, pnlBps, expectedProceedsLamports: quote.outAmount } });
    return { duplicate: false as const, orderId: order.id };
  });
}

// Idempotent: realized PnL uses the net SOL actually received, never the quote. Partial sells release cost proportionally.
export async function confirmLiveExit(orderId: string, execution: LiveSwapExecution) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    const [order] = await tx.update(orders).set({ status: "confirmed", signature: execution.signature, updatedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.mode, "live"), eq(orders.side, "sell"), inArray(orders.status, [...PENDING_LIVE_STATUSES]))).returning({ id: orders.id, tokenId: orders.tokenId, quoteRaw: orders.quoteRaw, origin: orders.origin });
    if (!order) return { duplicate: true as const, orderId, positionId: null, realizedPnlLamports: null, closed: false };
    const meta = (order.quoteRaw ?? {}) as { exitReason?: string; pnlBps?: number };
    await tx.update(orders).set({ quoteRaw: { ...(order.quoteRaw ?? {}), execution } }).where(eq(orders.id, order.id));
    await tx.insert(fills).values({ orderId: order.id, signature: execution.signature, baseAmountRaw: execution.tokenAmountRaw, quoteAmountRaw: execution.lamports, feeLamports: execution.feeLamports, slot: execution.slot === null ? null : BigInt(execution.slot), filledAt: execution.blockTime ?? new Date() }).onConflictDoNothing();
    const owner = order.origin === "manual" ? and(eq(positions.origin, "manual"), eq(positions.wallet, execution.wallet)) : eq(positions.origin, "auto");
    const [position] = await tx.select().from(positions).where(and(eq(positions.tokenId, order.tokenId), eq(positions.mode, "live"), inArray(positions.status, ["closing", "open"]), owner)).orderBy(desc(positions.openedAt)).limit(1).for("update");
    if (!position) { await tx.insert(auditLogs).values({ eventType: "live.exit.orphaned", entityType: "order", entityId: order.id, payload: { signature: execution.signature, origin: order.origin, tokenAmountRaw: execution.tokenAmountRaw, lamports: execution.lamports } }); return { duplicate: false as const, orderId: order.id, positionId: null, realizedPnlLamports: null, closed: false }; }
    // A wallet can sell more than the app tracked (tokens bought elsewhere); only the tracked quantity is accounted.
    const sold = BigInt(execution.tokenAmountRaw) > BigInt(position.quantityRaw) ? BigInt(position.quantityRaw) : BigInt(execution.tokenAmountRaw);
    const proceeds = sold === BigInt(execution.tokenAmountRaw) ? BigInt(execution.lamports) : BigInt(execution.lamports) * sold / BigInt(execution.tokenAmountRaw);
    const releasedCost = costPortion(position.costLamports, position.quantityRaw, sold), pnl = proceeds - releasedCost;
    const remaining = BigInt(position.quantityRaw) - sold, closed = remaining === 0n, realized = (BigInt(position.realizedPnlLamports) + pnl).toString();
    await tx.update(positions).set({ quantityRaw: remaining.toString(), costLamports: (BigInt(position.costLamports) - releasedCost).toString(), realizedPnlLamports: realized, status: closed ? "closed" : "open", ...(closed ? { closedAt: execution.blockTime ?? new Date() } : {}), updatedAt: new Date() }).where(eq(positions.id, position.id));
    // Alert-only triggers awaiting the user's action are resolved by the sell they prompted.
    const resolved = await tx.update(triggerOrders).set({ status: "filled", filledAt: new Date(), resultOrderId: order.id, updatedAt: new Date() }).where(and(eq(triggerOrders.positionId, position.id), eq(triggerOrders.status, "triggered"))).returning({ ocoGroup: triggerOrders.ocoGroup });
    for (const group of new Set(resolved.map((row) => row.ocoGroup).filter((value): value is string => value !== null))) await tx.update(triggerOrders).set({ status: "cancelled", lastError: "OCO sibling filled", updatedAt: new Date() }).where(and(eq(triggerOrders.ocoGroup, group), eq(triggerOrders.status, "active")));
    if (closed) await tx.update(triggerOrders).set({ status: "cancelled", lastError: "Position closed", updatedAt: new Date() }).where(and(eq(triggerOrders.positionId, position.id), eq(triggerOrders.status, "active")));
    await tx.insert(auditLogs).values({ eventType: "live.exit.confirmed", entityType: "order", entityId: order.id, payload: { mint: execution.tokenMint, positionId: position.id, origin: order.origin, reason: meta.exitReason ?? null, quotedPnlBps: meta.pnlBps ?? null, signature: execution.signature, proceedsLamports: proceeds.toString(), feeLamports: execution.feeLamports, releasedCostLamports: releasedCost.toString(), realizedPnlLamports: realized, remainingRaw: remaining.toString(), closed, wallet: execution.wallet } });
    return { duplicate: false as const, orderId: order.id, positionId: position.id, realizedPnlLamports: realized, closed };
  });
}

export async function listPendingLiveOrders(olderThanMs: number) {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: orders.id, side: orders.side, status: orders.status, signature: orders.signature, wallet: orders.wallet, lastValidBlockHeight: orders.lastValidBlockHeight, origin: orders.origin, createdAt: orders.createdAt, updatedAt: orders.updatedAt, mint: tokens.mint }).from(orders).innerJoin(tokens, eq(orders.tokenId, tokens.id)).where(and(eq(orders.mode, "live"), inArray(orders.status, [...PENDING_LIVE_STATUSES]), sql`${orders.updatedAt} < now() - (${olderThanMs} * interval '1 millisecond')`));
}

// A position left in `closing` with no pending sell order would never be exited again.
export async function releaseOrphanClosingPositions() {
  if (!hasDatabase()) return [];
  const rows = await getDatabase().update(positions).set({ status: "open", updatedAt: new Date() }).where(and(eq(positions.mode, "live"), eq(positions.status, "closing"), sql`not exists (select 1 from ${orders} where ${orders.tokenId} = ${positions.tokenId} and ${orders.mode} = 'live' and ${orders.side} = 'sell' and ${orders.status} in ('quoted','simulated','submitted'))`)).returning({ id: positions.id });
  return rows.map((row) => row.id);
}

// SOL committed today: confirmed buy fills plus buys still pending.
export async function getLiveSpentTodayLamports() {
  if (!hasDatabase()) return 0n;
  const db = getDatabase();
  const [filled] = await db.select({ total: sql<string>`coalesce(sum(${fills.quoteAmountRaw}),0)::text` }).from(fills).innerJoin(orders, eq(fills.orderId, orders.id)).where(and(eq(orders.mode, "live"), eq(orders.origin, "auto"), eq(orders.side, "buy"), sql`${fills.filledAt} >= date_trunc('day', now())`));
  const [pending] = await db.select({ total: sql<string>`coalesce(sum(${orders.requestedAmountRaw}),0)::text` }).from(orders).where(and(eq(orders.mode, "live"), eq(orders.origin, "auto"), eq(orders.side, "buy"), inArray(orders.status, [...PENDING_LIVE_STATUSES])));
  return BigInt(filled?.total ?? "0") + BigInt(pending?.total ?? "0");
}

export async function getLiveExpectedHoldings() {
  if (!hasDatabase()) return { expected: new Map<string, bigint>(), pendingMints: new Set<string>() };
  const db = getDatabase();
  const rows = await db.select({ mint: tokens.mint, quantity: sql<string>`sum(${positions.quantityRaw})::text` }).from(positions).innerJoin(tokens, eq(positions.tokenId, tokens.id)).where(and(eq(positions.mode, "live"), eq(positions.origin, "auto"), inArray(positions.status, ["open", "closing"]))).groupBy(tokens.mint);
  const pending = await db.select({ mint: tokens.mint }).from(orders).innerJoin(tokens, eq(orders.tokenId, tokens.id)).where(and(eq(orders.mode, "live"), eq(orders.origin, "auto"), inArray(orders.status, [...PENDING_LIVE_STATUSES])));
  return { expected: new Map(rows.map((row) => [row.mint, BigInt(row.quantity)])), pendingMints: new Set(pending.map((row) => row.mint)) };
}

export async function listRecentLiveOrders(limit = 30) {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: orders.id, side: orders.side, status: orders.status, signature: orders.signature, error: orders.error, requestedAmountRaw: orders.requestedAmountRaw, origin: orders.origin, wallet: orders.wallet, createdAt: orders.createdAt, updatedAt: orders.updatedAt, mint: tokens.mint, symbol: tokens.symbol, filledLamports: fills.quoteAmountRaw, feeLamports: fills.feeLamports }).from(orders).innerJoin(tokens, eq(orders.tokenId, tokens.id)).leftJoin(fills, eq(fills.orderId, orders.id)).where(eq(orders.mode, "live")).orderBy(desc(orders.createdAt)).limit(limit);
}

export async function listOpenPositionsForPricing() {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: positions.id, mode: positions.mode, mint: tokens.mint, decimals: tokens.decimals, quantityRaw: positions.quantityRaw, costLamports: positions.costLamports }).from(positions).innerJoin(tokens, eq(positions.tokenId, tokens.id)).where(and(inArray(positions.mode, ["shadow", "live"]), eq(positions.status, "open"), eq(positions.origin, "auto")));
}

export async function saveShadowExit(positionId: string, mint: string, quote: JupiterQuote, reason: string, pnlBps: number) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    const [position] = await tx.select().from(positions).where(and(eq(positions.id, positionId), eq(positions.mode, "shadow"), eq(positions.status, "open"))).for("update");
    if (!position) return { duplicate: true as const, orderId: null };
    const idempotencyKey = `shadow-exit:${position.id}`;
    const [order] = await tx.insert(orders).values({ tokenId: position.tokenId, mode: "shadow", side: "sell", status: "simulated", idempotencyKey, requestedAmountRaw: position.quantityRaw, quoteRaw: { ...quote, exitReason: reason, pnlBps } }).onConflictDoNothing().returning({ id: orders.id });
    if (!order) return { duplicate: true as const, orderId: null };
    const realizedPnl = (BigInt(quote.outAmount) - BigInt(position.costLamports)).toString();
    await tx.update(positions).set({ status: "closed", realizedPnlLamports: realizedPnl, closedAt: new Date(), updatedAt: new Date() }).where(eq(positions.id, position.id));
    await tx.insert(auditLogs).values({ eventType: "shadow.exit.simulated", entityType: "order", entityId: order.id, payload: { mint, positionId, reason, pnlBps, proceedsLamports: quote.outAmount, realizedPnlLamports: realizedPnl } });
    return { duplicate: false as const, orderId: order.id };
  });
}

export async function listShadowPositions() {
  if (!hasDatabase()) return [];
  const db = getDatabase();
  const rows = await db.select({ id: positions.id, mint: tokens.mint, symbol: tokens.symbol, name: tokens.name, tokenStatus: tokens.status, status: positions.status, origin: positions.origin, quantityRaw: positions.quantityRaw, costLamports: positions.costLamports, realizedPnlLamports: positions.realizedPnlLamports, openedAt: positions.openedAt, closedAt: positions.closedAt, updatedAt: positions.updatedAt }).from(positions).innerJoin(tokens, eq(positions.tokenId, tokens.id)).where(eq(positions.mode, "shadow")).orderBy(desc(positions.openedAt)).limit(200);
  return Promise.all(rows.map(async (row) => {
    const [mark] = await db.select({ valueLamports: positionMarks.valueLamports, unrealizedPnlLamports: positionMarks.unrealizedPnlLamports, pnlBps: positionMarks.pnlBps, markedAt: positionMarks.markedAt }).from(positionMarks).where(eq(positionMarks.positionId, row.id)).orderBy(desc(positionMarks.markedAt)).limit(1);
    if (row.status !== "closed") return { ...row, exitReason: null, exitPnlBps: null, mark: mark ?? null };
    const [audit] = await db.select({ payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.eventType, "shadow.exit.simulated"), sql`${auditLogs.payload}->>'positionId' = ${row.id}`)).orderBy(desc(auditLogs.createdAt)).limit(1);
    return { ...row, exitReason: typeof audit?.payload?.reason === "string" ? audit.payload.reason : null, exitPnlBps: typeof audit?.payload?.pnlBps === "number" ? audit.payload.pnlBps : null, mark: mark ?? null };
  }));
}

export async function getDatabaseHealth() {
  if (!hasDatabase()) return { connected: false };
  const db = getDatabase(); const started = Date.now();
  const [tokenCount] = await db.select({ count: sql<number>`count(*)::int` }).from(tokens);
  const [openPositions] = await db.select({ count: sql<number>`count(*)::int` }).from(positions).where(eq(positions.status,"open"));
  const [latestRisk] = await db.select({ at: riskAssessments.assessedAt }).from(riskAssessments).orderBy(desc(riskAssessments.assessedAt)).limit(1);
  const [latestHolder] = await db.select({ at: holderSnapshots.capturedAt }).from(holderSnapshots).orderBy(desc(holderSnapshots.capturedAt)).limit(1);
  const [latestMarket] = await db.select({ at: pools.updatedAt }).from(pools).orderBy(desc(pools.updatedAt)).limit(1);
  const [latestAudit] = await db.select({ at: auditLogs.createdAt, eventType: auditLogs.eventType }).from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(1);
  return { connected: true, latencyMs: Date.now()-started, tokenCount: tokenCount?.count??0, openPositions: openPositions?.count??0, latestRiskAt: latestRisk?.at??null, latestHolderAt: latestHolder?.at??null, latestMarketAt: latestMarket?.at??null, latestAudit: latestAudit??null };
}

export async function listShadowPerformanceTrades() {
  if (!hasDatabase()) return [];
  const db=getDatabase(),rows=await db.select({positionId:positions.id,mint:tokens.mint,symbol:tokens.symbol,pnlLamports:positions.realizedPnlLamports,openedAt:positions.openedAt,closedAt:positions.closedAt}).from(positions).innerJoin(tokens,eq(positions.tokenId,tokens.id)).where(and(eq(positions.mode,"shadow"),eq(positions.status,"closed"))).orderBy(positions.closedAt);
  return Promise.all(rows.map(async row=>{const [entryAudit]=await db.select({orderId:auditLogs.entityId}).from(auditLogs).where(and(eq(auditLogs.eventType,"shadow.entry.simulated"),sql`${auditLogs.payload}->>'positionId' = ${row.positionId}`)).limit(1);if(!entryAudit)return{...row,strategyVersion:"unknown",signalScore:null,metrics:null};const [entry]=await db.select({strategyVersion:signals.strategyVersion,score:signals.score,payload:signals.payload}).from(orders).leftJoin(signals,eq(orders.signalId,signals.id)).where(eq(orders.id,entryAudit.orderId)).limit(1);const metrics=entry?.payload&&typeof entry.payload.metrics==="object"?entry.payload.metrics as Record<string,unknown>:null;return{...row,strategyVersion:entry?.strategyVersion??"unknown",signalScore:entry?.score?Number(entry.score):null,metrics}}));
}

export type TradingControls = { entriesPaused: boolean; haltAll: boolean; reason: string | null; updatedAt: Date | null };
// Fail-safe defaults: entries stay paused until explicitly resumed; haltAll blocks every live send including exits.
export async function getTradingControls(): Promise<TradingControls> {
  if (!hasDatabase()) return { entriesPaused: true, haltAll: false, reason: "Database unavailable", updatedAt: null };
  const [row]=await getDatabase().select().from(runtimeSettings).where(eq(runtimeSettings.key,"trading-controls")).limit(1);const value=row?.value??{};
  return { entriesPaused: value.entriesPaused !== false || value.haltAll === true, haltAll: value.haltAll === true, reason: typeof value.reason==="string"?value.reason:null, updatedAt: row?.updatedAt??null };
}

export async function updateTradingControls(entriesPaused:boolean,reason:string|null,haltAll?:boolean) {
  if (!hasDatabase()) throw new Error("Database chưa cấu hình."); const db=getDatabase(),now=new Date(),current=await getTradingControls(),halt=haltAll??current.haltAll,value={entriesPaused:entriesPaused||halt,haltAll:halt,reason,changedAt:now.toISOString()};
  const [row]=await db.insert(runtimeSettings).values({key:"trading-controls",value,updatedAt:now}).onConflictDoUpdate({target:runtimeSettings.key,set:{value,updatedAt:now}}).returning();
  await db.insert(auditLogs).values({eventType:halt?"trading.halted":entriesPaused?"trading.entries.paused":"trading.entries.resumed",entityType:"runtime_setting",entityId:"trading-controls",payload:value}); return row;
}

export async function getRuntimeValue<T extends Record<string, unknown>>(key: string): Promise<T | null> {
  if (!hasDatabase()) return null;
  const [row] = await getDatabase().select().from(runtimeSettings).where(eq(runtimeSettings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}

export async function setRuntimeValue(key: string, value: Record<string, unknown>) {
  if (!hasDatabase()) return null;
  const now = new Date();
  const [row] = await getDatabase().insert(runtimeSettings).values({ key, value, updatedAt: now }).onConflictDoUpdate({ target: runtimeSettings.key, set: { value, updatedAt: now } }).returning();
  return row;
}

export async function getShadowSettings():Promise<ShadowSettings>{const defaults=defaultShadowSettings();if(!hasDatabase())return defaults;const[row]=await getDatabase().select().from(runtimeSettings).where(eq(runtimeSettings.key,"shadow-settings")).limit(1);return{...defaults,...(row?.value??{})} as ShadowSettings;}
export async function updateShadowSettings(settings:ShadowSettings){if(!hasDatabase())throw new Error("Database chưa cấu hình.");const db=getDatabase(),now=new Date();const[row]=await db.insert(runtimeSettings).values({key:"shadow-settings",value:settings,updatedAt:now}).onConflictDoUpdate({target:runtimeSettings.key,set:{value:settings,updatedAt:now}}).returning();await db.insert(auditLogs).values({eventType:"shadow.settings.updated",entityType:"runtime_setting",entityId:"shadow-settings",payload:{...settings,changedAt:now.toISOString()}});return row;}

export async function saveMintAssessment(mint: MintInspection, candidate: Candidate, checks: RiskCheck[], market: MarketInspection | null, migration: MigrationInspection | null, creator: CreatorInspection | null) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    const tokenValues = { symbol: market?.symbol ?? candidate.symbol, name: market?.name ?? candidate.name, launchpad: market?.launchpad ?? candidate.launchpad, tokenProgram: mint.tokenProgram, decimals: mint.decimals, supplyRaw: mint.supplyRaw, mintAuthority: mint.mintAuthority, freezeAuthority: mint.freezeAuthority, status: candidate.status, riskScore: candidate.riskScore, archivedAt: null, updatedAt: new Date() };
    const [token] = await tx.insert(tokens).values({ mint: mint.mint, ...tokenValues }).onConflictDoUpdate({ target: tokens.mint, set: tokenValues }).returning({ id: tokens.id });
    let poolId: string | null = null;
    if (market) { const [pool] = await tx.insert(pools).values({ tokenId: token.id, address: market.poolAddress, dex: market.dex, quoteMint: market.quoteMint, liquidityUsd: market.liquidityUsd?.toString(), volume1hUsd: market.volume1hUsd?.toString(), volume24hUsd: market.volume24hUsd?.toString(), priceChange1h: market.priceChange1h?.toString(), priceUsd: market.priceUsd, pairCreatedAt: market.pairCreatedAt, verified: Boolean(migration), updatedAt: new Date() }).onConflictDoUpdate({ target: pools.address, set: { liquidityUsd: market.liquidityUsd?.toString(), volume1hUsd: market.volume1hUsd?.toString(), volume24hUsd: market.volume24hUsd?.toString(), priceChange1h: market.priceChange1h?.toString(), priceUsd: market.priceUsd, pairCreatedAt: market.pairCreatedAt, verified: Boolean(migration), updatedAt: new Date() } }).returning({ id: pools.id }); poolId = pool.id; }
    if (migration) await tx.insert(migrationEvents).values({ tokenId: token.id, poolId, signature: migration.signature, slot: migration.slot, blockTime: migration.blockTime, verified: true }).onConflictDoUpdate({ target: migrationEvents.signature, set: { poolId, verified: true } });
    if (creator) { const ids: Record<string,string> = {}; for (const [role,address] of Object.entries({creator:creator.creator,user:creator.user,feePayer:creator.feePayer})) { const [wallet] = await tx.insert(wallets).values({ address }).onConflictDoUpdate({ target: wallets.address, set: { updatedAt: new Date() } }).returning({ id: wallets.id }); ids[role]=wallet.id; } await tx.insert(tokenCreators).values({ tokenId: token.id, creatorWalletId: ids.creator, userWalletId: ids.user, feePayerWalletId: ids.feePayer, signature: creator.signature, slot: creator.slot, blockTime: creator.blockTime, instruction: creator.instruction, verified: true }).onConflictDoUpdate({ target: tokenCreators.tokenId, set: { creatorWalletId: ids.creator, userWalletId: ids.user, feePayerWalletId: ids.feePayer, signature: creator.signature, slot: creator.slot, blockTime: creator.blockTime, instruction: creator.instruction, verified: true } }); }
    const [versionRow] = await tx.select({ next: sql<number>`coalesce(max(${riskAssessments.version}), 0) + 1` }).from(riskAssessments).where(eq(riskAssessments.tokenId, token.id));
    const [assessment] = await tx.insert(riskAssessments).values({ tokenId: token.id, version: Number(versionRow.next), status: candidate.status, score: candidate.riskScore, checks }).returning({ id: riskAssessments.id });
    await tx.insert(auditLogs).values({ eventType: "mint.assessed", entityType: "token", entityId: token.id, payload: { mint: mint.mint, assessmentId: assessment.id, status: candidate.status, score: candidate.riskScore, marketEnriched: Boolean(market), marketSource: market ? "dexscreener" : null } });
    return { tokenId: token.id, assessmentId: assessment.id };
  });
}

// ---------- Trigger orders (shadow) ----------
export type NewTriggerOrder = Omit<typeof triggerOrders.$inferInsert, "id" | "status" | "createdAt" | "updatedAt">;

export async function getTriggerContext(mint: string) {
  if (!hasDatabase()) return null;
  const db = getDatabase();
  const [token] = await db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1);
  if (!token) return null;
  const [pool] = await db.select({ priceUsd: pools.priceUsd }).from(pools).where(eq(pools.tokenId, token.id)).orderBy(desc(pools.liquidityUsd)).limit(1);
  const [position] = await db.select({ id: positions.id, origin: positions.origin, quantityRaw: positions.quantityRaw, costLamports: positions.costLamports, openedAt: positions.openedAt }).from(positions).where(and(eq(positions.tokenId, token.id), eq(positions.mode, "shadow"), eq(positions.status, "open"))).limit(1);
  const walletPositions = await db.select({ id: positions.id, wallet: positions.wallet, quantityRaw: positions.quantityRaw, costLamports: positions.costLamports }).from(positions).where(and(eq(positions.tokenId, token.id), eq(positions.mode, "live"), eq(positions.origin, "manual"), eq(positions.status, "open")));
  return { token, priceUsd: pool?.priceUsd ?? null, position: position ?? null, walletPositions };
}

export async function createTriggerOrders(rows: NewTriggerOrder[]) {
  if (!hasDatabase()) throw new Error("Database chưa cấu hình.");
  return getDatabase().transaction(async (tx) => {
    const created = await tx.insert(triggerOrders).values(rows).returning();
    for (const row of created) await tx.insert(auditLogs).values({ eventType: "trigger.created", entityType: "trigger_order", entityId: row.id, payload: { type: row.type, tokenId: row.tokenId, positionId: row.positionId, triggerMcapUsd: row.triggerMcapUsd, trailingBps: row.trailingBps, buyLamports: row.buyLamports, sellPctBps: row.sellPctBps, ocoGroup: row.ocoGroup } });
    return created;
  });
}

// Live alert-only triggers that already fired (waiting for the user to sell) can also be dismissed.
export async function cancelTriggerOrder(id: string, reason = "Cancelled by user") {
  if (!hasDatabase()) return null;
  const [row] = await getDatabase().update(triggerOrders).set({ status: "cancelled", lastError: reason, updatedAt: new Date() }).where(and(eq(triggerOrders.id, id), sql`(${triggerOrders.status} = 'active' or (${triggerOrders.status} = 'triggered' and ${triggerOrders.mode} = 'live'))`)).returning({ id: triggerOrders.id });
  return row ?? null;
}

export async function listTriggerOrders(options: { mint?: string; limit?: number } = {}) {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: triggerOrders.id, type: triggerOrders.type, status: triggerOrders.status, triggerMcapUsd: triggerOrders.triggerMcapUsd, trailingBps: triggerOrders.trailingBps, peakMcapUsd: triggerOrders.peakMcapUsd, buyLamports: triggerOrders.buyLamports, sellPctBps: triggerOrders.sellPctBps, maxSlippageBps: triggerOrders.maxSlippageBps, ocoGroup: triggerOrders.ocoGroup, mode: triggerOrders.mode, expiresAt: triggerOrders.expiresAt, lastMcapUsd: triggerOrders.lastMcapUsd, lastError: triggerOrders.lastError, positionId: triggerOrders.positionId, createdAt: triggerOrders.createdAt, filledAt: triggerOrders.filledAt, mint: tokens.mint, symbol: tokens.symbol }).from(triggerOrders).innerJoin(tokens, eq(triggerOrders.tokenId, tokens.id)).where(options.mint ? eq(tokens.mint, options.mint) : undefined).orderBy(desc(triggerOrders.createdAt)).limit(options.limit ?? 200);
}

// Housekeeping before each evaluation: expire old orders and cancel sell orders whose position is gone.
export async function sweepTriggerOrders() {
  if (!hasDatabase()) return { expired: 0, cancelled: 0 };
  const db = getDatabase();
  const expired = await db.update(triggerOrders).set({ status: "expired", updatedAt: new Date() }).where(and(eq(triggerOrders.status, "active"), sql`${triggerOrders.expiresAt} < now()`)).returning({ id: triggerOrders.id });
  const cancelled = await db.update(triggerOrders).set({ status: "cancelled", lastError: "Position closed", updatedAt: new Date() }).where(and(sql`(${triggerOrders.status} = 'active' or (${triggerOrders.status} = 'triggered' and ${triggerOrders.mode} = 'live'))`, isNotNull(triggerOrders.positionId), sql`not exists (select 1 from ${positions} where ${positions.id} = ${triggerOrders.positionId} and ${positions.status} = 'open')`)).returning({ id: triggerOrders.id });
  return { expired: expired.length, cancelled: cancelled.length };
}

export async function listActiveTriggersForPricing(modes: Array<"shadow" | "live"> = ["shadow"]) {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: triggerOrders.id, type: triggerOrders.type, mode: triggerOrders.mode, triggerMcapUsd: triggerOrders.triggerMcapUsd, trailingBps: triggerOrders.trailingBps, peakMcapUsd: triggerOrders.peakMcapUsd, mint: tokens.mint, supplyRaw: tokens.supplyRaw, decimals: tokens.decimals }).from(triggerOrders).innerJoin(tokens, eq(triggerOrders.tokenId, tokens.id)).where(and(eq(triggerOrders.status, "active"), inArray(triggerOrders.mode, modes.length ? modes : ["shadow"])));
}

export async function recordTriggerObservation(id: string, mcapUsd: number, peakMcapUsd: number | null) {
  if (!hasDatabase()) return;
  await getDatabase().update(triggerOrders).set({ lastMcapUsd: mcapUsd.toFixed(2), ...(peakMcapUsd === null ? {} : { peakMcapUsd: peakMcapUsd.toFixed(2) }), updatedAt: new Date() }).where(and(eq(triggerOrders.id, id), eq(triggerOrders.status, "active")));
}

// active -> triggered is the single-execution guard; only the caller that wins it may fill the order.
export async function claimTriggerOrder(id: string) {
  if (!hasDatabase()) return null;
  const db = getDatabase();
  const [order] = await db.update(triggerOrders).set({ status: "triggered", triggeredAt: new Date(), updatedAt: new Date() }).where(and(eq(triggerOrders.id, id), eq(triggerOrders.status, "active"))).returning();
  if (!order) return null;
  const [token] = await db.select().from(tokens).where(eq(tokens.id, order.tokenId)).limit(1);
  return { order, token };
}

export async function releaseTriggerOrder(id: string, error: string, status: "active" | "failed" | "cancelled" = "active") {
  if (!hasDatabase()) return;
  await getDatabase().update(triggerOrders).set({ status, lastError: error.slice(0, 500), updatedAt: new Date() }).where(and(eq(triggerOrders.id, id), eq(triggerOrders.status, "triggered")));
}

async function cancelSiblings(tx: Parameters<Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]>[0], order: typeof triggerOrders.$inferSelect, positionClosed: boolean) {
  if (order.ocoGroup) await tx.update(triggerOrders).set({ status: "cancelled", lastError: "OCO sibling filled", updatedAt: new Date() }).where(and(eq(triggerOrders.ocoGroup, order.ocoGroup), eq(triggerOrders.status, "active")));
  if (positionClosed && order.positionId) await tx.update(triggerOrders).set({ status: "cancelled", lastError: "Position closed", updatedAt: new Date() }).where(and(eq(triggerOrders.positionId, order.positionId), eq(triggerOrders.status, "active")));
}

export async function fillTriggerBuy(triggerId: string, quote: JupiterQuote, impliedMcapUsd: number) {
  if (!hasDatabase()) throw new Error("Database chưa cấu hình.");
  return getDatabase().transaction(async (tx) => {
    const [order] = await tx.update(triggerOrders).set({ status: "filled", filledAt: new Date(), lastError: null, updatedAt: new Date() }).where(and(eq(triggerOrders.id, triggerId), eq(triggerOrders.status, "triggered"), eq(triggerOrders.type, "limit_buy"))).returning();
    if (!order) throw new Error("Trigger order is no longer claimed.");
    const [existing] = await tx.select({ id: positions.id }).from(positions).where(and(eq(positions.tokenId, order.tokenId), eq(positions.mode, "shadow"), eq(positions.status, "open"))).limit(1);
    if (existing) throw new TriggerRejectedError("Token đã có vị thế shadow đang mở.");
    const [buy] = await tx.insert(orders).values({ tokenId: order.tokenId, mode: "shadow", side: "buy", status: "simulated", idempotencyKey: `trigger:${order.id}`, requestedAmountRaw: quote.inAmount, quoteRaw: { ...quote, triggerId: order.id, impliedMcapUsd } }).returning({ id: orders.id });
    const [position] = await tx.insert(positions).values({ tokenId: order.tokenId, mode: "shadow", status: "open", origin: "manual", quantityRaw: quote.outAmount, costLamports: quote.inAmount }).returning({ id: positions.id });
    await tx.update(triggerOrders).set({ resultOrderId: buy.id, positionId: position.id }).where(eq(triggerOrders.id, order.id));
    await tx.insert(auditLogs).values({ eventType: "shadow.entry.simulated", entityType: "order", entityId: buy.id, payload: { positionId: position.id, triggerId: order.id, origin: "manual", inputLamports: quote.inAmount, outputAmountRaw: quote.outAmount, impliedMcapUsd, priceImpactPct: quote.priceImpactPct ?? null } });
    return { orderId: buy.id, positionId: position.id };
  });
}

export async function fillTriggerSell(triggerId: string, quote: JupiterQuote, soldRaw: bigint, impliedMcapUsd: number) {
  if (!hasDatabase()) throw new Error("Database chưa cấu hình.");
  return getDatabase().transaction(async (tx) => {
    const [order] = await tx.update(triggerOrders).set({ status: "filled", filledAt: new Date(), lastError: null, updatedAt: new Date() }).where(and(eq(triggerOrders.id, triggerId), eq(triggerOrders.status, "triggered"))).returning();
    if (!order || !order.positionId) throw new Error("Trigger order is no longer claimed.");
    // Row lock serializes against automated exits and other triggers on the same position.
    const [position] = await tx.select().from(positions).where(and(eq(positions.id, order.positionId), eq(positions.status, "open"))).for("update");
    if (!position) throw new TriggerRejectedError("Vị thế không còn mở.");
    if (soldRaw <= 0n || soldRaw > BigInt(position.quantityRaw)) throw new TriggerRejectedError("Khối lượng bán không hợp lệ.");
    const releasedCost = costPortion(position.costLamports, position.quantityRaw, soldRaw), proceeds = BigInt(quote.outAmount), pnl = proceeds - releasedCost;
    const remaining = BigInt(position.quantityRaw) - soldRaw, closed = remaining === 0n, pnlBps = releasedCost === 0n ? 0 : Number(pnl * 10_000n / releasedCost);
    const [sell] = await tx.insert(orders).values({ tokenId: position.tokenId, mode: "shadow", side: "sell", status: "simulated", idempotencyKey: `trigger:${order.id}`, requestedAmountRaw: soldRaw.toString(), quoteRaw: { ...quote, triggerId: order.id, impliedMcapUsd, exitReason: `trigger_${order.type}`, pnlBps } }).returning({ id: orders.id });
    const realized = (BigInt(position.realizedPnlLamports) + pnl).toString();
    await tx.update(positions).set({ quantityRaw: remaining.toString(), costLamports: (BigInt(position.costLamports) - releasedCost).toString(), realizedPnlLamports: realized, ...(closed ? { status: "closed" as const, closedAt: new Date() } : {}), updatedAt: new Date() }).where(eq(positions.id, position.id));
    await tx.update(triggerOrders).set({ resultOrderId: sell.id }).where(eq(triggerOrders.id, order.id));
    await cancelSiblings(tx, order, closed);
    await tx.insert(auditLogs).values({ eventType: closed ? "shadow.exit.simulated" : "shadow.partial_exit.simulated", entityType: "order", entityId: sell.id, payload: { positionId: position.id, triggerId: order.id, reason: `trigger_${order.type}`, pnlBps, soldRaw: soldRaw.toString(), remainingRaw: remaining.toString(), proceedsLamports: quote.outAmount, releasedCostLamports: releasedCost.toString(), realizedPnlLamports: realized, impliedMcapUsd } });
    return { orderId: sell.id, positionId: position.id, closed, pnlBps, realizedPnlLamports: realized };
  });
}

// ---------- Manual trades from the user's browser wallet ----------
export async function createManualOrder(input: { mint: string; side: "buy" | "sell"; wallet: string; requestedAmountRaw: string; quote: JupiterQuote; lastValidBlockHeight: bigint }) {
  if (!hasDatabase()) throw new Error("Database chưa cấu hình.");
  return getDatabase().transaction(async (tx) => {
    const [token] = await tx.select({ id: tokens.id }).from(tokens).where(eq(tokens.mint, input.mint)).limit(1);
    if (!token) throw new Error("Token chưa có trong watchlist.");
    const [order] = await tx.insert(orders).values({ tokenId: token.id, mode: "live", origin: "manual", side: input.side, status: "quoted", idempotencyKey: `manual:${crypto.randomUUID()}`, requestedAmountRaw: input.requestedAmountRaw, quoteRaw: input.quote, wallet: input.wallet, lastValidBlockHeight: input.lastValidBlockHeight }).returning({ id: orders.id });
    await tx.insert(auditLogs).values({ eventType: "manual.order.prepared", entityType: "order", entityId: order.id, payload: { mint: input.mint, side: input.side, wallet: input.wallet, requestedAmountRaw: input.requestedAmountRaw, expectedOutRaw: input.quote.outAmount } });
    return order;
  });
}

export async function getManualOrder(id: string) {
  if (!hasDatabase()) return null;
  const [row] = await getDatabase().select({ id: orders.id, side: orders.side, status: orders.status, signature: orders.signature, wallet: orders.wallet, error: orders.error, lastValidBlockHeight: orders.lastValidBlockHeight, createdAt: orders.createdAt, mint: tokens.mint, symbol: tokens.symbol }).from(orders).innerJoin(tokens, eq(orders.tokenId, tokens.id)).where(and(eq(orders.id, id), eq(orders.origin, "manual"))).limit(1);
  return row ?? null;
}

// Records the signature the wallet returned after broadcasting. Accepted even when halted, cancelled or failed by recovery: the transaction may already be on-chain.
export async function markManualOrderSubmitted(id: string, signature: string) {
  if (!hasDatabase()) return null;
  const [row] = await getDatabase().update(orders).set({ status: "submitted", signature, sentAt: new Date(), updatedAt: new Date() }).where(and(eq(orders.id, id), eq(orders.origin, "manual"), isNull(orders.signature), inArray(orders.status, ["quoted", "failed", "cancelled"]))).returning({ id: orders.id });
  return row ?? null;
}

// Only before the user has signed: once a wallet may have broadcast, recovery decides.
export async function cancelManualOrder(id: string) {
  if (!hasDatabase()) return null;
  const [row] = await getDatabase().update(orders).set({ status: "cancelled", error: "Cancelled before signing", updatedAt: new Date() }).where(and(eq(orders.id, id), eq(orders.origin, "manual"), eq(orders.status, "quoted"), isNull(orders.signature))).returning({ id: orders.id });
  return row ?? null;
}

export async function isSignatureRecorded(signature: string) {
  if (!hasDatabase()) return false;
  const [row] = await getDatabase().select({ id: orders.id }).from(orders).where(eq(orders.signature, signature)).limit(1);
  return Boolean(row);
}

export async function attachRecoveredSignature(id: string, signature: string) {
  if (!hasDatabase()) return null;
  const [row] = await getDatabase().update(orders).set({ status: "submitted", signature, updatedAt: new Date() }).where(and(eq(orders.id, id), eq(orders.status, "quoted"), isNull(orders.signature))).returning({ id: orders.id });
  return row ?? null;
}

export async function listManualPositions(mint?: string) {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: positions.id, mint: tokens.mint, symbol: tokens.symbol, decimals: tokens.decimals, wallet: positions.wallet, quantityRaw: positions.quantityRaw, costLamports: positions.costLamports, realizedPnlLamports: positions.realizedPnlLamports, openedAt: positions.openedAt, status: positions.status }).from(positions).innerJoin(tokens, eq(positions.tokenId, tokens.id)).where(and(eq(positions.mode, "live"), eq(positions.origin, "manual"), eq(positions.status, "open"), mint ? eq(tokens.mint, mint) : undefined)).orderBy(desc(positions.openedAt));
}

export async function getShadowPositionById(id: string) {
  if (!hasDatabase()) return null;
  const [row] = await getDatabase().select().from(positions).where(and(eq(positions.id, id), eq(positions.mode, "shadow"))).limit(1);
  return row ?? null;
}

export async function refreshTokenSupply(mint: string, supplyRaw: string) {
  if (!hasDatabase()) return;
  await getDatabase().update(tokens).set({ supplyRaw }).where(eq(tokens.mint, mint));
}
