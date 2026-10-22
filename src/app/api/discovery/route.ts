import { NextResponse } from "next/server";
import { z } from "zod";
import { getDiscoverySettings, getDiscoveryStats, updateDiscoverySettings } from "@/db/repository";
import { enforceWriteRateLimit } from "@/lib/api-security";
import { heliusCreditsUsedToday } from "@/queue/client";
export const runtime = "nodejs";
const schema = z.object({ enabled: z.boolean(), retentionHours: z.number().int().min(1).max(168), recheckMinutes: z.number().int().min(2).max(60), heliusDailyCredits: z.number().int().min(0).max(5_000_000) }).strict();

export async function GET() {
  const [settings, stats, creditsUsed] = await Promise.all([getDiscoverySettings(), getDiscoveryStats(), heliusCreditsUsedToday().catch(() => null)]);
  return NextResponse.json({ settings, stats, creditsUsed });
}

export async function POST(request: Request) {
  const limited = await enforceWriteRateLimit(request, "discovery-settings", 20); if (limited) return limited;
  try { return NextResponse.json({ message: "Đã lưu cài đặt khám phá.", settings: await updateDiscoverySettings(schema.parse(await request.json())) }); }
  catch (error) { return NextResponse.json({ error: error instanceof z.ZodError ? error.issues[0]?.message ?? "Cài đặt không hợp lệ." : "Không thể lưu cài đặt." }, { status: error instanceof z.ZodError ? 422 : 503 }); }
}
