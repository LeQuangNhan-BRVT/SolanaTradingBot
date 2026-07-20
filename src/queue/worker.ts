import { config } from "dotenv";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { ANALYSIS_QUEUE, type DeepAnalysisJob } from "./client";
import { inspectMarket } from "../lib/market";
import { getCandidateDetail, refreshCandidateMarket, saveBundleAssessment, saveFinalRiskAssessment, saveHolderGraph } from "../db/repository";
import { inspectHolderGraph } from "../lib/graph";
import { inspectBundle } from "../lib/bundle";
import { assessCandidate } from "../lib/risk-engine";
import type { Candidate } from "../lib/types";

config({ path: ".env.local" });
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });

const worker = new Worker(ANALYSIS_QUEUE, async (job) => {
  if (typeof job.data?.mint !== "string") throw new Error("Unsupported analysis job.");
  if (job.name === "market-refresh") {
    const market = await inspectMarket(job.data.mint);
    if (!market) throw new Error("Không tìm thấy pool market cho token.");
    await refreshCandidateMarket(job.data.mint, market);
    return { mint: job.data.mint, refreshedAt: new Date().toISOString() };
  }
  if (job.name !== "holder-analysis" && job.name !== "holder-bundle-analysis") throw new Error("Unsupported analysis job.");
  const data = job.data as DeepAnalysisJob;
  const graph = await inspectHolderGraph(data.mint, data.tokenProgram, data.poolAddress, [data.creator.creator, data.creator.user, data.creator.feePayer]);
  const snapshot = await saveHolderGraph(data.mint, graph);
  if (!snapshot) throw new Error("Không thể lưu holder snapshot.");
  let bundlePct: number | null = null;
  let bundleCoverage: number | null = null;
  if (data.includeBundle && data.migration) {
    const bundle = await inspectBundle(data.mint, graph, new Date(data.creator.blockTime), new Date(data.migration.blockTime));
    await saveBundleAssessment(data.mint, snapshot.snapshotId, bundle);
    bundlePct = bundle.truncated ? null : bundle.suspectedBundlePct;
    bundleCoverage = bundle.coveredTransactions;
  } else {
    const current = await getCandidateDetail(data.mint);
    bundlePct = current?.bundle && !current.bundle.truncated ? Number(current.bundle.suspectedBundlePct) : null;
  }
  const detail = await getCandidateDetail(data.mint);
  if (!detail) throw new Error("Token không còn tồn tại.");
  const candidate: Candidate = { mint: data.mint, symbol: detail.token.symbol, name: detail.token.name, launchpad: detail.token.launchpad === "Pump.fun" || detail.token.launchpad === "BONK" ? detail.token.launchpad : "Unknown", migratedHours: detail.migration ? Math.max(0, (Date.now() - detail.migration.blockTime.getTime()) / 3_600_000) : null, riskScore: 0, bundlePct, clusterPct: graph.creatorClusterPct, liquidityUsd: detail.pool?.liquidityUsd ? Number(detail.pool.liquidityUsd) : null, volume1hUsd: detail.pool?.volume1hUsd ? Number(detail.pool.volume1hUsd) : null, priceChange1h: detail.pool?.priceChange1h ? Number(detail.pool.priceChange1h) : null, status: "monitoring", creator: data.creator.creator };
  const risk = assessCandidate(candidate, data.mintAuthority, data.freezeAuthority);
  Object.assign(candidate, { status: risk.status, riskScore: risk.riskScore, checks: risk.checks });
  await saveFinalRiskAssessment(data.mint, candidate, risk.checks);
  return { mint: data.mint, snapshotId: snapshot.snapshotId, bundleCoverage, status: candidate.status, analyzedAt: new Date().toISOString() };
}, { connection, concurrency: 2 });

worker.on("completed", (job) => console.log("Analysis completed", job.name, job.id));
worker.on("failed", (job, error) => console.error("Analysis failed", job?.name, job?.id, error.message));
async function shutdown() { await worker.close(); await connection.quit(); process.exit(0); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
