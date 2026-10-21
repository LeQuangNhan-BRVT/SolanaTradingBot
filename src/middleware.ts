import { NextRequest, NextResponse } from "next/server";
import { authConfigurationError, authRequired, COOKIE_NAME, verifySessionToken } from "@/lib/auth";

const publicPaths = new Set(["/login", "/api/auth/login", "/api/live"]);
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const expected = process.env.APP_ORIGIN || request.nextUrl.origin;
  return origin === expected;
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (publicPaths.has(pathname)) {
    if (pathname === "/login" && await verifySessionToken(request.cookies.get(COOKIE_NAME)?.value)) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  const configError = authConfigurationError();
  if (authRequired() && configError) return NextResponse.json({ error: "Authentication is not configured safely." }, { status: 503 });

  if (!await verifySessionToken(request.cookies.get(COOKIE_NAME)?.value)) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  if (unsafeMethods.has(request.method) && !sameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
