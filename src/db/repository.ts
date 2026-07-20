import { and, desc, eq, sql } from "drizzle-orm";
import { getDatabase, hasDatabase } from "./client";
import { auditLogs, bundleAssessments, holderBalances, holderSnapshots, migrationEvents, pools, riskAssessments, tokenCreators, tokens, walletFundingEdges, wallets } from "./schema";
import type { Candidate, MintInspection, RiskCheck } from "@/lib/types";
import type { MarketInspection } from "@/lib/market";
import type { MigrationInspection } from "@/lib/migration";
import type { CreatorInspection } from "@/lib/creator";
import type { HolderGraph } from "@/lib/graph";
import type { BundleAssessment } from "@/lib/bundle";

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
