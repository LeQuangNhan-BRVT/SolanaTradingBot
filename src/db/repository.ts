import { and, desc, eq, sql } from "drizzle-orm";
import { getDatabase, hasDatabase } from "./client";
import { auditLogs, bundleAssessments, holderBalances, holderSnapshots, migrationEvents, orders, pools, positionMarks, positions, riskAssessments, runtimeSettings, signals, tokenCreators, tokens, walletFundingEdges, wallets } from "./schema";
import type { Candidate, MintInspection, RiskCheck } from "@/lib/types";
import type { MarketInspection } from "@/lib/market";
import type { MigrationInspection } from "@/lib/migration";
import type { CreatorInspection } from "@/lib/creator";
import type { HolderGraph } from "@/lib/graph";
import type { BundleAssessment } from "@/lib/bundle";
import type { JupiterQuote } from "@/lib/shadow";
import type { LiveSwapExecution } from "@/lib/live";
import type { EntryDecision, PortfolioState } from "@/lib/strategy";
import { defaultShadowSettings, type ShadowSettings } from "@/lib/settings";

export async function saveHolderGraph(mint:string,graph:HolderGraph){if(!hasDatabase())return null;return getDatabase().transaction(async tx=>{const [token]=await tx.select({id:tokens.id}).from(tokens).where(eq(tokens.mint,mint)).limit(1);if(!token)throw new Error("Token chưa tồn tại.");const [snapshot]=await tx.insert(holderSnapshots).values({tokenId:token.id,slot:graph.slot,supplyRaw:graph.supplyRaw,creatorClusterPct:graph.creatorClusterPct.toString()}).returning({id:holderSnapshots.id});for(const node of graph.holders){let walletId:string|null=null;if(node.owner!=="unknown"){const [wallet]=await tx.insert(wallets).values({address:node.owner}).onConflictDoUpdate({target:wallets.address,set:{updatedAt:new Date()}}).returning({id:wallets.id});walletId=wallet.id}await tx.insert(holderBalances).values({snapshotId:snapshot.id,walletId,tokenAccount:node.tokenAccount,rank:node.rank,amountRaw:node.amountRaw,percentage:node.percentage.toString(),excluded:node.excluded,exclusionReason:node.exclusionReason});if(node.funding&&walletId){const [source]=await tx.insert(wallets).values({address:node.funding.from}).onConflictDoUpdate({target:wallets.address,set:{updatedAt:new Date()}}).returning({id:wallets.id});await tx.insert(walletFundingEdges).values({fromWalletId:source.id,toWalletId:walletId,signature:node.funding.signature,lamports:node.funding.lamports,slot:node.funding.slot,blockTime:node.funding.blockTime}).onConflictDoNothing()}}return{snapshotId:snapshot.id,creatorClusterPct:graph.creatorClusterPct}})}

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
  const [pool] = await db.insert(pools).values({ tokenId: token.id, address: market.poolAddress, dex: market.dex, quoteMint: market.quoteMint, liquidityUsd: market.liquidityUsd?.toString(), volume1hUsd: market.volume1hUsd?.toString(), volume24hUsd: market.volume24hUsd?.toString(), priceChange1h: market.priceChange1h?.toString(), pairCreatedAt: market.pairCreatedAt, verified: false, updatedAt: new Date() }).onConflictDoUpdate({ target: pools.address, set: { liquidityUsd: market.liquidityUsd?.toString(), volume1hUsd: market.volume1hUsd?.toString(), volume24hUsd: market.volume24hUsd?.toString(), priceChange1h: market.priceChange1h?.toString(), pairCreatedAt: market.pairCreatedAt, updatedAt: new Date() } }).returning({ id: pools.id });
  return { tokenId: token.id, poolId: pool.id };
}

export async function listCandidates(): Promise<Candidate[]> {
  if (!hasDatabase()) return [];
  const db = getDatabase();
  const rows = await db.select().from(tokens).orderBy(desc(tokens.updatedAt)).limit(100);
  return Promise.all(rows.map(async (row) => {
    const [pool] = await db.select().from(pools).where(eq(pools.tokenId, row.id)).orderBy(desc(pools.liquidityUsd)).limit(1);
    const [risk] = await db.select().from(riskAssessments).where(eq(riskAssessments.tokenId, row.id)).orderBy(desc(riskAssessments.version)).limit(1);
    const [migration] = await db.select().from(migrationEvents).where(and(eq(migrationEvents.tokenId, row.id), eq(migrationEvents.verified, true))).orderBy(desc(migrationEvents.blockTime)).limit(1);
    const [creatorRow] = await db.select({ address: wallets.address }).from(tokenCreators).innerJoin(wallets, eq(tokenCreators.creatorWalletId, wallets.id)).where(eq(tokenCreators.tokenId, row.id)).limit(1);
    const migratedHours = migration ? Math.max(0, (Date.now() - migration.blockTime.getTime()) / 3_600_000) : null;
    return { mint: row.mint, symbol: row.symbol, name: row.name, launchpad: row.launchpad === "Pump.fun" || row.launchpad === "BONK" ? row.launchpad : "Unknown", migratedHours, riskScore: row.riskScore, bundlePct: risk?.suspectedBundlePct === null || risk?.suspectedBundlePct === undefined ? null : Number(risk.suspectedBundlePct), clusterPct: risk?.creatorClusterPct === null || risk?.creatorClusterPct === undefined ? null : Number(risk.creatorClusterPct), liquidityUsd: pool?.liquidityUsd ? Number(pool.liquidityUsd) : null, volume1hUsd: pool?.volume1hUsd ? Number(pool.volume1hUsd) : null, priceChange1h: pool?.priceChange1h ? Number(pool.priceChange1h) : null, status: row.status, creator: creatorRow?.address ?? null };
  }));
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
  const rows = await getDatabase().select({ mint: tokens.mint }).from(tokens).where(eq(tokens.status, "eligible"));
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
    const [pendingOrder] = await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.tokenId, token.id), eq(orders.mode, "live"), eq(orders.side, "buy"), sql`${orders.status} in ('created','quoted','submitted')`)).limit(1);
    if (pendingOrder) return { duplicate: true as const, orderId: pendingOrder.id, positionId: null };
    const idempotencyKey = `live-entry:v1:${token.id}:${riskAssessmentId}:${quote.inAmount}:${Math.floor(Date.now() / 60_000)}`;
    const [signal] = await tx.insert(signals).values({ tokenId: token.id, riskAssessmentId, strategyVersion: "live-v1", idempotencyKey, score: decision.score.toString(), payload: { reason: "strategy_accepted", quoteSource: "jupiter", inputMint: quote.inputMint, outputMint: quote.outputMint, metrics: decision.metrics } }).onConflictDoNothing().returning({ id: signals.id });
    if (!signal) return { duplicate: true as const, orderId: null, positionId: null };
    const [order] = await tx.insert(orders).values({ signalId: signal.id, tokenId: token.id, mode: "live", side: "buy", status: "quoted", idempotencyKey, requestedAmountRaw: quote.inAmount, quoteRaw: quote }).returning({ id: orders.id });
    await tx.insert(auditLogs).values({ eventType: "live.entry.reserved", entityType: "order", entityId: order.id, payload: { mint, inputLamports: quote.inAmount, expectedOutputAmountRaw: quote.outAmount, score: decision.score } });
    return { duplicate: false as const, orderId: order.id, positionId: null };
  });
}

export async function markLiveOrderSubmitted(orderId: string, signature: string) {
  if (!hasDatabase()) return null;
  const [order] = await getDatabase().update(orders).set({ status: "submitted", signature, updatedAt: new Date() }).where(eq(orders.id, orderId)).returning({ id: orders.id });
  return order ?? null;
}

export async function markLiveOrderFailed(orderId: string, error: string) {
  if (!hasDatabase()) return null;
  const db = getDatabase();
  const [order] = await db.update(orders).set({ status: "failed", error: error.slice(0, 2_000), updatedAt: new Date() }).where(eq(orders.id, orderId)).returning({ id: orders.id, side: orders.side });
  return order ?? null;
}

export async function confirmLiveEntry(orderId: string, mint: string, quote: JupiterQuote, execution: LiveSwapExecution) {
  if (!hasDatabase()) return null;
  if (BigInt(execution.outputDeltaRaw) <= 0n) throw new Error("Live entry output delta is zero.");
  return getDatabase().transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.mode, "live"), eq(orders.side, "buy"))).limit(1);
    if (!order) return { duplicate: true as const, orderId: null, positionId: null };
    await tx.update(orders).set({ status: "confirmed", signature: execution.signature, quoteRaw: { ...quote, execution }, updatedAt: new Date() }).where(eq(orders.id, order.id));
    const [position] = await tx.insert(positions).values({ tokenId: order.tokenId, mode: "live", status: "open", quantityRaw: execution.outputDeltaRaw, costLamports: quote.inAmount }).returning({ id: positions.id });
    await tx.insert(auditLogs).values({ eventType: "live.entry.confirmed", entityType: "order", entityId: order.id, payload: { mint, positionId: position.id, signature: execution.signature, inputLamports: quote.inAmount, outputAmountRaw: execution.outputDeltaRaw, wallet: execution.wallet, priorityFeeLamports: execution.prioritizationFeeLamports } });
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
    const [position] = await tx.select().from(positions).where(and(eq(positions.id, positionId), eq(positions.mode, "live"), eq(positions.status, "open"))).limit(1);
    if (!position) return { duplicate: true as const, orderId: null };
    const idempotencyKey = `live-exit:${position.id}`;
    const [order] = await tx.insert(orders).values({ tokenId: position.tokenId, mode: "live", side: "sell", status: "quoted", idempotencyKey, requestedAmountRaw: position.quantityRaw, quoteRaw: { ...quote, exitReason: reason, pnlBps } }).onConflictDoNothing().returning({ id: orders.id });
    if (!order) return { duplicate: true as const, orderId: null };
    await tx.update(positions).set({ status: "closing", updatedAt: new Date() }).where(eq(positions.id, position.id));
    await tx.insert(auditLogs).values({ eventType: "live.exit.reserved", entityType: "order", entityId: order.id, payload: { mint, positionId, reason, pnlBps, expectedProceedsLamports: quote.outAmount } });
    return { duplicate: false as const, orderId: order.id };
  });
}

export async function failLiveExit(positionId: string, orderId: string, error: string) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    await tx.update(orders).set({ status: "failed", error: error.slice(0, 2_000), updatedAt: new Date() }).where(eq(orders.id, orderId));
    await tx.update(positions).set({ status: "open", updatedAt: new Date() }).where(and(eq(positions.id, positionId), eq(positions.status, "closing")));
    return { orderId, positionId };
  });
}

export async function confirmLiveExit(positionId: string, mint: string, orderId: string, quote: JupiterQuote, reason: string, pnlBps: number, execution: LiveSwapExecution) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    const [position] = await tx.select().from(positions).where(and(eq(positions.id, positionId), eq(positions.mode, "live"), eq(positions.status, "closing"))).limit(1);
    if (!position) return { duplicate: true as const, orderId: null };
    const proceeds = BigInt(execution.outputDeltaRaw) > 0n ? execution.outputDeltaRaw : quote.outAmount;
    const realizedPnl = (BigInt(proceeds) - BigInt(position.costLamports)).toString();
    await tx.update(orders).set({ status: "confirmed", signature: execution.signature, quoteRaw: { ...quote, execution, exitReason: reason, pnlBps }, updatedAt: new Date() }).where(eq(orders.id, orderId));
    await tx.update(positions).set({ status: "closed", realizedPnlLamports: realizedPnl, closedAt: new Date(), updatedAt: new Date() }).where(eq(positions.id, position.id));
    await tx.insert(auditLogs).values({ eventType: "live.exit.confirmed", entityType: "order", entityId: orderId, payload: { mint, positionId, reason, pnlBps, signature: execution.signature, proceedsLamports: proceeds, realizedPnlLamports: realizedPnl, wallet: execution.wallet } });
    return { duplicate: false as const, orderId };
  });
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

export async function getTradingControls() {
  if (!hasDatabase()) return { entriesPaused: true, reason: "Database unavailable", updatedAt: null as Date|null };
  const [row]=await getDatabase().select().from(runtimeSettings).where(eq(runtimeSettings.key,"trading-controls")).limit(1);const value=row?.value??{};
  return { entriesPaused: value.entriesPaused !== false, reason: typeof value.reason==="string"?value.reason:null, updatedAt: row?.updatedAt??null };
}

export async function updateTradingControls(entriesPaused:boolean,reason:string|null) {
  if (!hasDatabase()) throw new Error("Database chưa cấu hình."); const db=getDatabase(),now=new Date(),value={entriesPaused,reason,changedAt:now.toISOString()};
  const [row]=await db.insert(runtimeSettings).values({key:"trading-controls",value,updatedAt:now}).onConflictDoUpdate({target:runtimeSettings.key,set:{value,updatedAt:now}}).returning();
  await db.insert(auditLogs).values({eventType:entriesPaused?"trading.entries.paused":"trading.entries.resumed",entityType:"runtime_setting",entityId:"trading-controls",payload:value}); return row;
}

export async function getShadowSettings():Promise<ShadowSettings>{const defaults=defaultShadowSettings();if(!hasDatabase())return defaults;const[row]=await getDatabase().select().from(runtimeSettings).where(eq(runtimeSettings.key,"shadow-settings")).limit(1);return{...defaults,...(row?.value??{})} as ShadowSettings;}
export async function updateShadowSettings(settings:ShadowSettings){if(!hasDatabase())throw new Error("Database chưa cấu hình.");const db=getDatabase(),now=new Date();const[row]=await db.insert(runtimeSettings).values({key:"shadow-settings",value:settings,updatedAt:now}).onConflictDoUpdate({target:runtimeSettings.key,set:{value:settings,updatedAt:now}}).returning();await db.insert(auditLogs).values({eventType:"shadow.settings.updated",entityType:"runtime_setting",entityId:"shadow-settings",payload:{...settings,changedAt:now.toISOString()}});return row;}

export async function saveMintAssessment(mint: MintInspection, candidate: Candidate, checks: RiskCheck[], market: MarketInspection | null, migration: MigrationInspection | null, creator: CreatorInspection | null) {
  if (!hasDatabase()) return null;
  return getDatabase().transaction(async (tx) => {
    const tokenValues = { symbol: market?.symbol ?? candidate.symbol, name: market?.name ?? candidate.name, launchpad: market?.launchpad ?? candidate.launchpad, tokenProgram: mint.tokenProgram, decimals: mint.decimals, supplyRaw: mint.supplyRaw, mintAuthority: mint.mintAuthority, freezeAuthority: mint.freezeAuthority, status: candidate.status, riskScore: candidate.riskScore, updatedAt: new Date() };
    const [token] = await tx.insert(tokens).values({ mint: mint.mint, ...tokenValues }).onConflictDoUpdate({ target: tokens.mint, set: tokenValues }).returning({ id: tokens.id });
    let poolId: string | null = null;
    if (market) { const [pool] = await tx.insert(pools).values({ tokenId: token.id, address: market.poolAddress, dex: market.dex, quoteMint: market.quoteMint, liquidityUsd: market.liquidityUsd?.toString(), volume1hUsd: market.volume1hUsd?.toString(), volume24hUsd: market.volume24hUsd?.toString(), priceChange1h: market.priceChange1h?.toString(), pairCreatedAt: market.pairCreatedAt, verified: Boolean(migration), updatedAt: new Date() }).onConflictDoUpdate({ target: pools.address, set: { liquidityUsd: market.liquidityUsd?.toString(), volume1hUsd: market.volume1hUsd?.toString(), volume24hUsd: market.volume24hUsd?.toString(), priceChange1h: market.priceChange1h?.toString(), pairCreatedAt: market.pairCreatedAt, verified: Boolean(migration), updatedAt: new Date() } }).returning({ id: pools.id }); poolId = pool.id; }
    if (migration) await tx.insert(migrationEvents).values({ tokenId: token.id, poolId, signature: migration.signature, slot: migration.slot, blockTime: migration.blockTime, verified: true }).onConflictDoUpdate({ target: migrationEvents.signature, set: { poolId, verified: true } });
    if (creator) { const ids: Record<string,string> = {}; for (const [role,address] of Object.entries({creator:creator.creator,user:creator.user,feePayer:creator.feePayer})) { const [wallet] = await tx.insert(wallets).values({ address }).onConflictDoUpdate({ target: wallets.address, set: { updatedAt: new Date() } }).returning({ id: wallets.id }); ids[role]=wallet.id; } await tx.insert(tokenCreators).values({ tokenId: token.id, creatorWalletId: ids.creator, userWalletId: ids.user, feePayerWalletId: ids.feePayer, signature: creator.signature, slot: creator.slot, blockTime: creator.blockTime, instruction: creator.instruction, verified: true }).onConflictDoUpdate({ target: tokenCreators.tokenId, set: { creatorWalletId: ids.creator, userWalletId: ids.user, feePayerWalletId: ids.feePayer, signature: creator.signature, slot: creator.slot, blockTime: creator.blockTime, instruction: creator.instruction, verified: true } }); }
    const [versionRow] = await tx.select({ next: sql<number>`coalesce(max(${riskAssessments.version}), 0) + 1` }).from(riskAssessments).where(eq(riskAssessments.tokenId, token.id));
    const [assessment] = await tx.insert(riskAssessments).values({ tokenId: token.id, version: Number(versionRow.next), status: candidate.status, score: candidate.riskScore, checks }).returning({ id: riskAssessments.id });
    await tx.insert(auditLogs).values({ eventType: "mint.assessed", entityType: "token", entityId: token.id, payload: { mint: mint.mint, assessmentId: assessment.id, status: candidate.status, score: candidate.riskScore, marketEnriched: Boolean(market), marketSource: market ? "dexscreener" : null } });
    return { tokenId: token.id, assessmentId: assessment.id };
  });
}
