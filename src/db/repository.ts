import { and, desc, eq, sql } from "drizzle-orm";
import { getDatabase, hasDatabase } from "./client";
import { auditLogs, migrationEvents, pools, riskAssessments, tokenCreators, tokens, wallets } from "./schema";
import type { Candidate, MintInspection, RiskCheck } from "@/lib/types";
import type { MarketInspection } from "@/lib/market";
import type { MigrationInspection } from "@/lib/migration";
import type { CreatorInspection } from "@/lib/creator";

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
