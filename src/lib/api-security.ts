import { NextResponse } from "next/server";
import { checkRateLimit, requestClientId } from "@/lib/rate-limit";

export async function enforceWriteRateLimit(request: Request, action: string, limit = 30, windowSeconds = 60) {
  const rate = await checkRateLimit(`write:${action}:${requestClientId(request)}`, limit, windowSeconds);
  if (rate.allowed) return null;
  return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": String(rate.retryAfter), "X-RateLimit-Remaining": String(rate.remaining) } });
}
