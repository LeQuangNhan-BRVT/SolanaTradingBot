import { getRiskLimits, saveMintAssessment } from "@/db/repository";
import { scheduleDeepAnalysis, scheduleMarketRefresh } from "@/queue/client";
import { inspectPumpCreator } from "./creator";
import { inspectMarket } from "./market";
import { verifyPumpMigration, type MigrationInspection } from "./migration";
import { assessCandidate } from "./risk-engine";
import { inspectMint } from "./solana";
import type { Candidate } from "./types";

// Verifies a CA, stores the assessment and schedules background analysis. Discovery passes the migration it already
// observed on-chain, which skips the expensive migration search.
export async function assessAndSaveCandidate(address: string, known: { migration?: MigrationInspection } = {}) {
  const mint = await inspectMint(address);
  const market = await inspectMarket(mint.mint).catch((error) => { console.error("Market enrichment failed", error); return null; });
  const migration = known.migration ?? (market?.launchpad === "Pump.fun" ? await verifyPumpMigration(mint.mint, market.poolAddress, market.pairCreatedAt).catch((error) => { console.error("Migration verification failed", error); return null; }) : null);
  const migratedHours = migration ? Math.max(0, (Date.now() - migration.blockTime.getTime()) / 3_600_000) : null;
  const creator = market?.launchpad === "Pump.fun" || known.migration ? await inspectPumpCreator(mint.mint).catch((error) => { console.error("Creator inspection failed", error); return null; }) : null;
  const candidate: Candidate = { mint: mint.mint, symbol: market?.symbol ?? "—", name: market?.name ?? "Token chưa nhận diện", launchpad: market?.launchpad ?? (known.migration ? "Pump.fun" : "Unknown"), migratedHours, riskScore: 0, bundlePct: null, clusterPct: null, liquidityUsd: market?.liquidityUsd ?? null, volume1hUsd: market?.volume1hUsd ?? null, priceChange1h: market?.priceChange1h ?? null, status: "monitoring" };
  const result = assessCandidate(candidate, mint.mintAuthority, mint.freezeAuthority, await getRiskLimits());
  Object.assign(candidate, { status: result.status, riskScore: result.riskScore, checks: result.checks });
  candidate.creator = creator?.creator ?? null;
  const persisted = await saveMintAssessment(mint, candidate, result.checks, market, migration, creator);
  await scheduleMarketRefresh(mint.mint).catch((error) => console.error("Unable to schedule market refresh", error));
  const analysisJob = creator ? await scheduleDeepAnalysis({ mint: mint.mint, tokenProgram: mint.tokenProgram, mintAuthority: mint.mintAuthority, freezeAuthority: mint.freezeAuthority, poolAddress: market?.poolAddress ?? migration?.poolAddress ?? null, creator: { creator: creator.creator, user: creator.user, feePayer: creator.feePayer, blockTime: creator.blockTime.toISOString() }, migration: migration ? { blockTime: migration.blockTime.toISOString() } : null }).catch((error) => { console.error("Unable to schedule deep analysis", error); return null; }) : null;
  return { candidate, mint, checks: result.checks, persisted: { ...persisted, analysisJobId: analysisJob?.id ?? null } };
}
