import { NextResponse } from "next/server";
import { z } from "zod";
import { authConfigurationError, createSessionToken, sessionCookie, verifyAdminPassword } from "@/lib/auth";
import { checkRateLimit, requestClientId } from "@/lib/rate-limit";

export const runtime = "nodejs";
const schema = z.object({ password: z.string().min(1).max(256) });

export async function POST(request: Request) {
  const configError = authConfigurationError();
  if (configError) return NextResponse.json({ error: configError }, { status: 503 });

  const origin = request.headers.get("origin");
  const expected = process.env.APP_ORIGIN || new URL(request.url).origin;
  if (!origin || origin !== expected) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });

  const rate = await checkRateLimit(`login:${requestClientId(request)}`, 5, 15 * 60);
  if (!rate.allowed) return NextResponse.json({ error: "Too many login attempts." }, { status: 429, headers: { "Retry-After": String(rate.retryAfter) } });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !verifyAdminPassword(parsed.data.password)) return NextResponse.json({ error: "Invalid password." }, { status: 401 });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie(await createSessionToken()));
  return response;
}
