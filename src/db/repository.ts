import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDatabase, hasDatabase } from "./client";
import { auditLogs, bundleAssessments, fills, holderBalances, holderSnapshots, migrationEvents, orders, pools, positionMarks, positions, riskAssessments, runtimeSettings, signals, tokenCreators, tokens, trackedWallets, walletFundingEdges, wallets } from "./schema";
import { normalizeTags, type WatchAlertConfig, type WatchlistPatch } from "@/lib/watchlist";
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

export async function saveTrackedWallet(address: string, label: string | null) {
  if (!hasDatabase()) throw new Error("Database chưa được cấu hình.");
  const [row] = await getDatabase().insert(trackedWallets).values({ address, label }).onConflictDoUpdate({ target: trackedWallets.address, set: { label, updatedAt: new Date() } }).returning();
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

// Idempotent: only the first caller (live path or recovery job) moves the order to confirmed and opens the position.
export async function confirmLiveEntry(orderId: string, execution: LiveSwapExecution) {
  if (!hasDatabase()) return null;
  if (BigInt(execution.tokenAmountRaw) <= 0n) throw new Error("Live entry token amount is zero.");
  return getDatabase().transaction(async (tx) => {
    const [order] = await tx.update(orders).set({ status: "confirmed", signature: execution.signature, updatedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.mode, "live"), eq(orders.side, "buy"), inArray(orders.status, [...PENDING_LIVE_STATUSES]))).returning({ id: orders.id, tokenId: orders.tokenId, quoteRaw: orders.quoteRaw });
    if (!order) return { duplicate: true as const, orderId, positionId: null };
    await tx.update(orders).set({ quoteRaw: { ...(order.quoteRaw ?? {}), execution } }).where(eq(orders.id, order.id));
    await tx.insert(fills).values({ orderId: order.id, signature: execution.signature, baseAmountRaw: execution.tokenAmountRaw, quoteAmountRaw: execution.lamports, feeLamports: execution.feeLamports, slot: execution.slot === null ? null : BigInt(execution.slot), filledAt: execution.blockTime ?? new Date() }).onConflictDoNothing();
    const [position] = await tx.insert(positions).values({ tokenId: order.tokenId, mode: "live", status: "open", quantityRaw: execution.tokenAmountRaw, costLamports: execution.lamports }).returning({ id: positions.id });
    await tx.insert(auditLogs).values({ eventType: "live.entry.confirmed", entityType: "order", entityId: order.id, payload: { mint: execution.tokenMint, positionId: position.id, signature: execution.signature, costLamports: execution.lamports, feeLamports: execution.feeLamports, tokenAmountRaw: execution.tokenAmountRaw, wallet: execution.wallet } });
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
  const [open] = await db.select({ count: sql<number>`count(*)::int`, exposure: sql<string>`coalesce(sum(${positions.costLamports}),0)::text` }).from(positions).where(and(eq(positions.mode,"live"),eq(positions.status,"open")));
  const [daily] = await db.select({ pnl: sql<string>`coalesce(sum(${positions.realizedPnlLamports}),0)::text` }).from(positions).where(and(eq(positions.mode,"live"),eq(positions.status,"closed"),sql`${positions.closedAt} >= date_trunc('day', now())`));
  const recent = await db.select({ pnl: positions.realizedPnlLamports }).from(positions).where(and(eq(positions.mode,"live"),eq(positions.status,"closed"))).orderBy(desc(positions.closedAt)).limit(20);
  let consecutiveLosses=0; for(const item of recent){if(BigInt(item.pnl)<0n)consecutiveLosses++;else break;}
  const [last] = await db.select({ closedAt: positions.closedAt }).from(positions).innerJoin(tokens,eq(positions.tokenId,tokens.id)).where(and(eq(tokens.mint,mint),eq(positions.mode,"live"),eq(positions.status,"closed"))).orderBy(desc(positions.closedAt)).limit(1);
  return { openCount: open?.count??0, exposureLamports: open?.exposure??"0", dailyRealizedPnlLamports: daily?.pnl??"0", consecutiveLosses, lastClosedAt: last?.closedAt??null };
}

export async function listOpenShadowPositions() {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: positions.id, mint: tokens.mint, tokenStatus: tokens.status, quantityRaw: positions.quantityRaw, costLamports: positions.costLamports, openedAt: positions.openedAt }).from(positions).innerJoin(tokens, eq(positions.tokenId, tokens.id)).where(and(eq(positions.mode, "shadow"), eq(positions.status, "open")));
}

export async function listOpenLivePositions() {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: positions.id, mint: tokens.mint, tokenStatus: tokens.status, quantityRaw: positions.quantityRaw, costLamports: positions.costLamports, openedAt: positions.openedAt }).from(positions).innerJoin(tokens, eq(positions.tokenId, tokens.id)).where(and(eq(positions.mode, "live"), eq(positions.status, "open")));
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

// Idempotent: realized PnL uses the net SOL actually received, never the quote.
export async function confirmLiveExit(orderId: string, execution: LiveSwapExecution) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    const [order] = await tx.update(orders).set({ status: "confirmed", signature: execution.signature, updatedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.mode, "live"), eq(orders.side, "sell"), inArray(orders.status, [...PENDING_LIVE_STATUSES]))).returning({ id: orders.id, tokenId: orders.tokenId, quoteRaw: orders.quoteRaw });
    if (!order) return { duplicate: true as const, orderId, positionId: null, realizedPnlLamports: null };
    const meta = (order.quoteRaw ?? {}) as { exitReason?: string; pnlBps?: number };
    await tx.update(orders).set({ quoteRaw: { ...(order.quoteRaw ?? {}), execution } }).where(eq(orders.id, order.id));
    await tx.insert(fills).values({ orderId: order.id, signature: execution.signature, baseAmountRaw: execution.tokenAmountRaw, quoteAmountRaw: execution.lamports, feeLamports: execution.feeLamports, slot: execution.slot === null ? null : BigInt(execution.slot), filledAt: execution.blockTime ?? new Date() }).onConflictDoNothing();
    const [position] = await tx.select().from(positions).where(and(eq(positions.tokenId, order.tokenId), eq(positions.mode, "live"), inArray(positions.status, ["closing", "open"]))).orderBy(desc(positions.openedAt)).limit(1);
    if (!position) { await tx.insert(auditLogs).values({ eventType: "live.exit.orphaned", entityType: "order", entityId: order.id, payload: { signature: execution.signature } }); return { duplicate: false as const, orderId: order.id, positionId: null, realizedPnlLamports: null }; }
    const realizedPnl = (BigInt(execution.lamports) - BigInt(position.costLamports)).toString();
    const remaining = BigInt(position.quantityRaw) - BigInt(execution.tokenAmountRaw);
    await tx.update(positions).set({ status: "closed", realizedPnlLamports: realizedPnl, closedAt: execution.blockTime ?? new Date(), updatedAt: new Date() }).where(eq(positions.id, position.id));
    await tx.insert(auditLogs).values({ eventType: "live.exit.confirmed", entityType: "order", entityId: order.id, payload: { mint: execution.tokenMint, positionId: position.id, reason: meta.exitReason ?? null, quotedPnlBps: meta.pnlBps ?? null, signature: execution.signature, proceedsLamports: execution.lamports, feeLamports: execution.feeLamports, realizedPnlLamports: realizedPnl, remainingRaw: remaining > 0n ? remaining.toString() : "0", wallet: execution.wallet } });
    return { duplicate: false as const, orderId: order.id, positionId: position.id, realizedPnlLamports: realizedPnl };
  });
}

export async function listPendingLiveOrders(olderThanMs: number) {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: orders.id, side: orders.side, status: orders.status, signature: orders.signature, wallet: orders.wallet, lastValidBlockHeight: orders.lastValidBlockHeight, updatedAt: orders.updatedAt, mint: tokens.mint }).from(orders).innerJoin(tokens, eq(orders.tokenId, tokens.id)).where(and(eq(orders.mode, "live"), inArray(orders.status, [...PENDING_LIVE_STATUSES]), sql`${orders.updatedAt} < now() - (${olderThanMs} * interval '1 millisecond')`));
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
  const [filled] = await db.select({ total: sql<string>`coalesce(sum(${fills.quoteAmountRaw}),0)::text` }).from(fills).innerJoin(orders, eq(fills.orderId, orders.id)).where(and(eq(orders.mode, "live"), eq(orders.side, "buy"), sql`${fills.filledAt} >= date_trunc('day', now())`));
  const [pending] = await db.select({ total: sql<string>`coalesce(sum(${orders.requestedAmountRaw}),0)::text` }).from(orders).where(and(eq(orders.mode, "live"), eq(orders.side, "buy"), inArray(orders.status, [...PENDING_LIVE_STATUSES])));
  return BigInt(filled?.total ?? "0") + BigInt(pending?.total ?? "0");
}

export async function getLiveExpectedHoldings() {
  if (!hasDatabase()) return { expected: new Map<string, bigint>(), pendingMints: new Set<string>() };
  const db = getDatabase();
  const rows = await db.select({ mint: tokens.mint, quantity: sql<string>`sum(${positions.quantityRaw})::text` }).from(positions).innerJoin(tokens, eq(positions.tokenId, tokens.id)).where(and(eq(positions.mode, "live"), inArray(positions.status, ["open", "closing"]))).groupBy(tokens.mint);
  const pending = await db.select({ mint: tokens.mint }).from(orders).innerJoin(tokens, eq(orders.tokenId, tokens.id)).where(and(eq(orders.mode, "live"), inArray(orders.status, [...PENDING_LIVE_STATUSES])));
  return { expected: new Map(rows.map((row) => [row.mint, BigInt(row.quantity)])), pendingMints: new Set(pending.map((row) => row.mint)) };
}

export async function listRecentLiveOrders(limit = 30) {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: orders.id, side: orders.side, status: orders.status, signature: orders.signature, error: orders.error, requestedAmountRaw: orders.requestedAmountRaw, createdAt: orders.createdAt, updatedAt: orders.updatedAt, mint: tokens.mint, symbol: tokens.symbol, filledLamports: fills.quoteAmountRaw, feeLamports: fills.feeLamports }).from(orders).innerJoin(tokens, eq(orders.tokenId, tokens.id)).leftJoin(fills, eq(fills.orderId, orders.id)).where(eq(orders.mode, "live")).orderBy(desc(orders.createdAt)).limit(limit);
}

export async function listOpenPositionsForPricing() {
  if (!hasDatabase()) return [];
  return getDatabase().select({ id: positions.id, mode: positions.mode, mint: tokens.mint, decimals: tokens.decimals, quantityRaw: positions.quantityRaw, costLamports: positions.costLamports }).from(positions).innerJoin(tokens, eq(positions.tokenId, tokens.id)).where(and(inArray(positions.mode, ["shadow", "live"]), eq(positions.status, "open")));
}

export async function saveShadowExit(positionId: string, mint: string, quote: JupiterQuote, reason: string, pnlBps: number) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    const [position] = await tx.select().from(positions).where(and(eq(positions.id, positionId), eq(positions.mode, "shadow"), eq(positions.status, "open"))).limit(1);
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
  const rows = await db.select({ id: positions.id, mint: tokens.mint, symbol: tokens.symbol, name: tokens.name, tokenStatus: tokens.status, status: positions.status, quantityRaw: positions.quantityRaw, costLamports: positions.costLamports, realizedPnlLamports: positions.realizedPnlLamports, openedAt: positions.openedAt, closedAt: positions.closedAt, updatedAt: positions.updatedAt }).from(positions).innerJoin(tokens, eq(positions.tokenId, tokens.id)).where(eq(positions.mode, "shadow")).orderBy(desc(positions.openedAt)).limit(200);
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
