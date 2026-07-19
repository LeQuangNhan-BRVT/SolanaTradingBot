import { Queue } from "bullmq";
import IORedis from "ioredis";

export const ANALYSIS_QUEUE = "candidate-analysis";
let connection: IORedis | undefined;
let queue: Queue | undefined;

function redisConnection() {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  connection ??= new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  return connection;
}

export function analysisQueue() { queue ??= new Queue(ANALYSIS_QUEUE, { connection: redisConnection() }); return queue; }

export async function scheduleMarketRefresh(mint: string) {
  const queue = analysisQueue();
  const options = { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential" as const, delay: 5_000 } };
  await queue.add("market-refresh", { mint }, { ...options, jobId: `initial-${mint}-${Date.now()}` });
  return queue.add("market-refresh", { mint }, { ...options, jobId: `market-${mint}`, repeat: { every: 300_000 } });
}
