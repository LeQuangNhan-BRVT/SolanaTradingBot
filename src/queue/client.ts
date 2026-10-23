import { Queue } from "bullmq";
import IORedis from "ioredis";

export const ANALYSIS_QUEUE = "candidate-analysis-v2";
let connection: IORedis | undefined;
let queue: Queue | undefined;

function redisConnection() {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  connection ??= new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  return connection;
}

// Daily Helius credit budget shared by every history-based discovery check. Returns false (and reserves nothing) when exhausted.
export async function reserveHeliusCredits(credits: number, dailyBudget: number) {
  const redis = redisConnection(), key = `aegis:helius-credits:${new Date().toISOString().slice(0, 10)}`;
  const used = await redis.incrby(key, credits);
  if (used === credits) await redis.expire(key, 3 * 86_400);
  if (used > dailyBudget) { await redis.decrby(key, credits); return false; }
  return true;
}

// Corrects a reservation once the actual cost is known (Helius bills per transaction returned).
export async function adjustHeliusCredits(delta: number) {
  if (delta !== 0) await redisConnection().incrby(`aegis:helius-credits:${new Date().toISOString().slice(0, 10)}`, delta);
}

export async function heliusCreditsUsedToday() {
  return Number(await redisConnection().get(`aegis:helius-credits:${new Date().toISOString().slice(0, 10)}`) ?? 0);
}

export async function scheduleDiscoveryCycle() {
  return analysisQueue().add("discovery-cycle", {}, { jobId: "discovery-cycle", repeat: { every: 60_000 }, removeOnComplete: 20, removeOnFail: 100 });
}

// Best-effort mutual exclusion across worker jobs; returns null when another holder owns the lock.
export async function withRedisLock<T>(key: string, ttlSeconds: number, run: () => Promise<T>): Promise<T | null> {
  const redis = redisConnection(), token = `${process.pid}:${Date.now()}:${Math.random()}`;
  if (await redis.set(`aegis:lock:${key}`, token, "EX", ttlSeconds, "NX") !== "OK") return null;
  try { return await run(); }
  finally { await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", 1, `aegis:lock:${key}`, token); }
}

// Lets short-lived processes (scripts, tests) exit once they are done with the queue.
export async function closeQueueConnections() {
  await queue?.close(); await connection?.quit();
  queue = undefined; connection = undefined;
}

export function analysisQueue() { queue ??= new Queue(ANALYSIS_QUEUE, { connection: redisConnection() }); return queue; }

export async function getQueueHealth() {
  const redis = redisConnection(), counts = await analysisQueue().getJobCounts("waiting","active","completed","failed","delayed","paused"), heartbeat = await redis.get("aegis:worker:heartbeat"), heartbeatTtl = await redis.ttl("aegis:worker:heartbeat");
  return { connected: (await redis.ping()) === "PONG", counts, heartbeat, heartbeatTtl, workerOnline: heartbeatTtl > 0 };
}

export async function scheduleMarketRefresh(mint: string) {
  const queue = analysisQueue();
  const options = { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential" as const, delay: 5_000 } };
  await queue.add("market-refresh", { mint }, { ...options, jobId: `initial-${mint}-${Date.now()}` });
  return queue.add("market-refresh", { mint }, { ...options, jobId: `market-${mint}`, repeat: { every: 300_000 } });
}

// Repeat options must match the ones used when scheduling, otherwise BullMQ cannot find the repeatable job.
export async function unscheduleTokenJobs(mint: string) {
  const queue = analysisQueue();
  const [market, holders] = await Promise.all([
    queue.removeRepeatable("market-refresh", { every: 300_000 }, `market-${mint}`),
    queue.removeRepeatable("holder-analysis", { every: 900_000 }, `holders-${mint}`),
  ]);
  return { market, holders };
}

export type DeepAnalysisJob = { mint: string; tokenProgram: string; mintAuthority: string | null; freezeAuthority: string | null; poolAddress: string | null; creator: { creator: string; user: string; feePayer: string; blockTime: string }; migration: { blockTime: string } | null; includeBundle: boolean };

export async function scheduleDeepAnalysis(data: Omit<DeepAnalysisJob, "includeBundle">) {
  const queue = analysisQueue();
  const options = { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential" as const, delay: 10_000 } };
  const initial = await queue.add("holder-bundle-analysis", { ...data, includeBundle: true }, { ...options, jobId: `deep-${data.mint}-${Date.now()}` });
  await queue.add("holder-analysis", { ...data, includeBundle: false }, { ...options, jobId: `holders-${data.mint}`, repeat: { every: 900_000 } });
  await scheduleShadowScan();
  return initial;
}

export async function scheduleLiveSafetyJobs() {
  const queue = analysisQueue(), options = { removeOnComplete: 50, removeOnFail: 200 };
  await queue.add("live-recovery", {}, { ...options, jobId: "live-recovery", repeat: { every: 30_000 } });
  await queue.add("live-reconcile", {}, { ...options, jobId: "live-reconcile", repeat: { every: 300_000 } });
}

// Deduplicated per position within a 15s window so the 5s price loop cannot pile up quote requests.
export async function requestExitCheck(mode: "shadow" | "live", positionId: string) {
  return analysisQueue().add("exit-check", { mode, positionId }, { jobId: `exit-check-${positionId}-${Math.floor(Date.now() / 15_000)}`, removeOnComplete: 100, removeOnFail: 200 });
}

export async function requestTriggerExecute(triggerId: string) {
  return analysisQueue().add("trigger-execute", { triggerId }, { jobId: `trigger-${triggerId}-${Math.floor(Date.now() / 15_000)}`, removeOnComplete: 100, removeOnFail: 200 });
}

export async function scheduleShadowScan() {
  const queue = analysisQueue(); const options = { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential" as const, delay: 10_000 } };
  await queue.add("shadow-scan", {}, { ...options, jobId: `shadow-now-${Math.floor(Date.now() / 60_000)}` });
  return queue.add("shadow-scan", {}, { ...options, jobId: "shadow-scan", repeat: { every: 60_000 } });
}
