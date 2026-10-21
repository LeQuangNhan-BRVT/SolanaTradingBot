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

export type DeepAnalysisJob = { mint: string; tokenProgram: string; mintAuthority: string | null; freezeAuthority: string | null; poolAddress: string | null; creator: { creator: string; user: string; feePayer: string; blockTime: string }; migration: { blockTime: string } | null; includeBundle: boolean };

export async function scheduleDeepAnalysis(data: Omit<DeepAnalysisJob, "includeBundle">) {
  const queue = analysisQueue();
  const options = { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential" as const, delay: 10_000 } };
  const initial = await queue.add("holder-bundle-analysis", { ...data, includeBundle: true }, { ...options, jobId: `deep-${data.mint}-${Date.now()}` });
  await queue.add("holder-analysis", { ...data, includeBundle: false }, { ...options, jobId: `holders-${data.mint}`, repeat: { every: 900_000 } });
  await scheduleShadowScan();
  return initial;
}

export async function scheduleShadowScan() {
  const queue = analysisQueue(); const options = { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential" as const, delay: 10_000 } };
  await queue.add("shadow-scan", {}, { ...options, jobId: `shadow-now-${Math.floor(Date.now() / 60_000)}` });
  return queue.add("shadow-scan", {}, { ...options, jobId: "shadow-scan", repeat: { every: 60_000 } });
}
