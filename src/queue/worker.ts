import { config } from "dotenv";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { ANALYSIS_QUEUE } from "./client";
import { inspectMarket } from "../lib/market";
import { refreshCandidateMarket } from "../db/repository";

config({ path: ".env.local" });

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const worker = new Worker(ANALYSIS_QUEUE, async (job) => {
  if (job.name !== "market-refresh" || typeof job.data?.mint !== "string") throw new Error("Unsupported analysis job.");
  const market = await inspectMarket(job.data.mint);
  if (!market) throw new Error("Không tìm thấy pool market cho token.");
  await refreshCandidateMarket(job.data.mint, market);
  return { mint: job.data.mint, refreshedAt: new Date().toISOString() };
}, { connection, concurrency: 4 });

worker.on("completed", (job) => console.log("Market refresh completed", job.id));
worker.on("failed", (job, error) => console.error("Market refresh failed", job?.id, error.message));
async function shutdown() { await worker.close(); await connection.quit(); process.exit(0); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
