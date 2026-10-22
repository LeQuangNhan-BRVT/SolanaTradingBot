import { NextResponse } from "next/server";
import { getDiscoveredToken, updateDiscoveredToken } from "@/db/repository";
import { enforceWriteRateLimit } from "@/lib/api-security";
import { promoteDiscovered } from "@/lib/discovery";
export const runtime = "nodejs";

// Manual promotion: adds a discovered token to the watchlist regardless of presets (tagged "thu-cong").
export async function POST(request: Request, context: { params: Promise<{ mint: string }> }) {
  const limited = await enforceWriteRateLimit(request, "discovery-promote", 20); if (limited) return limited;
  const token = await getDiscoveredToken((await context.params).mint);
  if (!token) return NextResponse.json({ error: "Không tìm thấy token trong hộp khám phá." }, { status: 404 });
  if (token.status === "promoted") return NextResponse.json({ message: "Token đã ở trong watchlist." });
  try {
    await promoteDiscovered(token, null);
    await updateDiscoveredToken(token.id, { status: "promoted", promotedAt: new Date() });
    return NextResponse.json({ message: "Đã thêm vào watchlist; đang xác minh nền." });
  } catch (error) {
    return NextResponse.json({ error: `Không thể thêm: ${error instanceof Error ? error.message : String(error)}` }, { status: 503 });
  }
}
