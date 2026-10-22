import { NextResponse } from "next/server";
import { z } from "zod";
import { getRiskLimits, updateRiskLimits } from "@/db/repository";
import { enforceWriteRateLimit } from "@/lib/api-security";
import { riskLimitsSchema } from "@/lib/risk-engine";
export const runtime = "nodejs";
export async function GET() { return NextResponse.json(await getRiskLimits()); }
export async function POST(request: Request) {
  const limited = await enforceWriteRateLimit(request, "risk-limits", 10); if (limited) return limited;
  try { return NextResponse.json({ message: "Đã lưu ngưỡng hard gate. Áp dụng từ lần đánh giá kế tiếp của mỗi token.", limits: await updateRiskLimits(riskLimitsSchema.parse(await request.json())) }); }
  catch (error) { return NextResponse.json({ error: error instanceof z.ZodError ? error.issues[0]?.message ?? "Ngưỡng không hợp lệ." : "Không thể lưu ngưỡng." }, { status: error instanceof z.ZodError ? 422 : 503 }); }
}
