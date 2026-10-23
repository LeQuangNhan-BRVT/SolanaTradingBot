import { NextResponse } from "next/server";
import { searchEverything } from "@/db/repository";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 64);
  // A pasted Solana address lets the palette offer "add this CA" or "track this wallet" when nothing matches yet.
  const isAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(query.trim());
  return NextResponse.json({ query, isAddress, ...(await searchEverything(query)) });
}
