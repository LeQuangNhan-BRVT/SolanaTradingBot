import { NextResponse } from "next/server";
import { z } from "zod";
import { saveMintAssessment } from "@/db/repository";
import { assessCandidate } from "@/lib/risk-engine";
import { inspectMint, MintValidationError } from "@/lib/solana";
import type { Candidate } from "@/lib/types";
import { inspectMarket } from "@/lib/market";
import { verifyPumpMigration } from "@/lib/migration";
import { scheduleDeepAnalysis, scheduleMarketRefresh } from "@/queue/client";
import { inspectPumpCreator } from "@/lib/creator";
export const runtime = "nodejs";
const requestSchema = z.object({ mint: z.string().trim().min(32).max(44) });
export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    const mint = await inspectMint(input.mint);
    const market = await inspectMarket(mint.mint).catch((error) => { console.error("Market enrichment failed", error); return null; });
    const migration = market?.launchpad === "Pump.fun" ? await verifyPumpMigration(mint.mint, market.poolAddress, market.pairCreatedAt).catch((error) => { console.error("Migration verification failed", error); return null; }) : null;
    const migratedHours = migration ? Math.max(0, (Date.now() - migration.blockTime.getTime()) / 3_600_000) : null;
    const creator = market?.launchpad === "Pump.fun" ? await inspectPumpCreator(mint.mint).catch((error) => { console.error("Creator inspection failed", error); return null; }) : null;
    const candidate: Candidate = { mint: mint.mint, symbol: market?.symbol ?? "—", name: market?.name ?? "Token chưa nhận diện", launchpad: market?.launchpad ?? "Unknown", migratedHours, riskScore: 0, bundlePct: null, clusterPct: null, liquidityUsd: market?.liquidityUsd ?? null, volume1hUsd: market?.volume1hUsd ?? null, priceChange1h: market?.priceChange1h ?? null, status: "monitoring" };
    const result = assessCandidate(candidate, mint.mintAuthority, mint.freezeAuthority);
    Object.assign(candidate, { status: result.status, riskScore: result.riskScore, checks: result.checks });
    candidate.creator = creator?.creator ?? null;
    const persisted = await saveMintAssessment(mint, candidate, result.checks, market, migration, creator);
    await scheduleMarketRefresh(mint.mint).catch((error) => console.error("Unable to schedule market refresh", error));
    const analysisJob = creator ? await scheduleDeepAnalysis({ mint: mint.mint, tokenProgram: mint.tokenProgram, mintAuthority: mint.mintAuthority, freezeAuthority: mint.freezeAuthority, poolAddress: market?.poolAddress ?? null, creator: { creator: creator.creator, user: creator.user, feePayer: creator.feePayer, blockTime: creator.blockTime.toISOString() }, migration: migration ? { blockTime: migration.blockTime.toISOString() } : null }).catch((error) => { console.error("Unable to schedule deep analysis", error); return null; }) : null;
    return NextResponse.json({ message: candidate.status === "rejected" ? "CA hợp lệ nhưng không vượt qua hard gate." : "Đã xác minh mint. Holder và bundle analysis đang chạy nền.", persisted: { ...persisted, analysisJobId: analysisJob?.id ?? null }, assessment: { candidate, mint, checks: result.checks, summary: "Fail-closed: chưa giao dịch khi còn kiểm tra quan trọng chưa xác minh." } }, { status: 202 });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof MintValidationError) return NextResponse.json({ error: error instanceof MintValidationError ? error.message : "CA Solana không hợp lệ." }, { status: 422 });
    console.error("Mint inspection failed", error);
    return NextResponse.json({ error: "Không thể truy vấn Solana RPC hoặc database. Vui lòng thử lại.", ...(process.env.NODE_ENV === "development" ? { detail: error instanceof Error ? error.message : String(error) } : {}) }, { status: 503 });
  }
}
