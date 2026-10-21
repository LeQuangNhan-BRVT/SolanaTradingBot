import { NextResponse } from "next/server";
import { enforceWriteRateLimit } from "@/lib/api-security";
import { scheduleShadowScan } from "@/queue/client";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limited = await enforceWriteRateLimit(request, "shadow-scan", 6);
  if (limited) return limited;
  const job = await scheduleShadowScan();
  return NextResponse.json({ message: "Shadow scan enqueued.", jobId: job.id }, { status: 202 });
}
