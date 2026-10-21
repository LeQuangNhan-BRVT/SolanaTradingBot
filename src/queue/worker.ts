import { config } from "dotenv";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { ANALYSIS_QUEUE, requestExitCheck, requestTriggerExecute, scheduleLiveSafetyJobs, withRedisLock, type DeepAnalysisJob } from "./client";
import { inspectMarket } from "../lib/market";
import { getCandidateDetail, getWatchAlertConfig, isTokenArchived, refreshCandidateMarket, refreshTokenSupply, saveBundleAssessment, saveFinalRiskAssessment, saveHolderGraph } from "../db/repository";
import { evaluateWatchAlerts } from "../lib/watchlist";
import { inspectHolderGraph } from "../lib/graph";
import { inspectBundle } from "../lib/bundle";
import { assessCandidate } from "../lib/risk-engine";
import type { Candidate } from "../lib/types";
import { executeExitCheck, executeShadowScan } from "../lib/shadow";
import { reconcileLiveWallet, recoverLiveOrders } from "../lib/live-recovery";
import { runPriceLoop } from "../lib/price-monitor";
import { executeTriggerOrder } from "../lib/trigger-engine";
import { fetchTokenSupply } from "../lib/solana";
import { sendAlertOnce } from "../lib/alerts";

config({ path: ".env.local" });
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const heartbeat = async () => connection.set("aegis:worker:heartbeat", new Date().toISOString(), "EX", 45);
void heartbeat(); const heartbeatTimer = setInterval(() => void heartbeat(), 15_000);

const worker = new Worker(ANALYSIS_QUEUE, async (job) => {
  if (job.name === "shadow-scan") return executeShadowScan();
  if (job.name === "live-recovery") return (await withRedisLock("live-recovery", 120, () => recoverLiveOrders())) ?? { skipped: true, reason: "recovery already running" };
  if (job.name === "live-reconcile") return reconcileLiveWallet();
  if (job.name === "exit-check") return executeExitCheck(job.data.mode, job.data.positionId);
  if (job.name === "trigger-execute") return executeTriggerOrder(job.data.triggerId);
  if (typeof job.data?.mint !== "string") throw new Error("Unsupported analysis job.");
  if (await isTokenArchived(job.data.mint)) return { mint: job.data.mint, skipped: true, reason: "archived" };
  if (job.name === "market-refresh") {
    const market = await inspectMarket(job.data.mint);
    if (!market) throw new Error("Không tìm thấy pool market cho token.");
    await refreshCandidateMarket(job.data.mint, market);
    // Supply changes with burns; market-cap triggers depend on it.
    await fetchTokenSupply(job.data.mint).then((supply) => refreshTokenSupply(job.data.mint, supply)).catch((error) => console.error("Supply refresh failed", error instanceof Error ? error.message : error));
    const alertConfig = await getWatchAlertConfig(job.data.mint);
    const alerts = alertConfig ? evaluateWatchAlerts(alertConfig, market) : [];
    for (const alert of alerts) void sendAlertOnce(`watch:${job.data.mint}:${alert.kind}`, 60 * 60_000, { type: `watchlist.${alert.kind}`, severity: "info", title: `Watchlist ${alertConfig?.symbol ?? job.data.mint.slice(0, 6)}`, message: alert.message, data: { mint: job.data.mint, priceUsd: market.priceUsd, priceChange1h: market.priceChange1h } });
    return { mint: job.data.mint, refreshedAt: new Date().toISOString(), alerts: alerts.map((item) => item.kind) };
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

void scheduleLiveSafetyJobs().catch((error) => console.error("Unable to schedule live safety jobs", error));

// Fast price loop: polls Jupiter every 5s and queues an exact exit check for positions near a threshold.
let priceScanRunning = false;
const priceTimer = setInterval(() => {
  if (priceScanRunning) return;
  priceScanRunning = true;
  runPriceLoop({ requestExitCheck: ({ mode, positionId }) => requestExitCheck(mode, positionId).then(() => undefined), requestTriggerExecute: (triggerId) => requestTriggerExecute(triggerId).then(() => undefined) })
    .catch((error) => void sendAlertOnce("price-loop-error", 15 * 60_000, { type: "worker.price_loop.error", severity: "warning", title: "Price loop error", message: error instanceof Error ? error.message : String(error) }))
    .finally(() => { priceScanRunning = false; });
}, Number(process.env.PRICE_LOOP_INTERVAL_MS ?? 5_000));

const quietJobs = new Set(["live-recovery", "live-reconcile", "exit-check", "trigger-execute"]);
worker.on("completed", (job) => { if (!quietJobs.has(job.name)) console.log("Analysis completed", job.name, job.id); });
worker.on("failed", (job, error) => {console.error("Analysis failed", job?.name, job?.id, error.message);void sendAlertOnce(`job-failed:${job?.name}:${job?.id}`,60*60_000,{type:"worker.job.failed",severity:"critical",title:"BullMQ job failed",message:`${job?.name??"unknown"}: ${error.message}`,data:{jobId:job?.id??null,jobName:job?.name??null,attemptsMade:job?.attemptsMade??null}});});
async function shutdown() { clearInterval(heartbeatTimer); clearInterval(priceTimer); await worker.close(); await connection.del("aegis:worker:heartbeat"); await connection.quit(); process.exit(0); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
