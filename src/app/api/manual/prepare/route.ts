import { NextResponse } from "next/server";
import { z } from "zod";
import { enforceWriteRateLimit } from "@/lib/api-security";
import { ManualTradeError, prepareManualTrade } from "@/lib/manual-trading";
import { WalletAddressError } from "@/lib/wallet-tracker";
export const runtime = "nodejs";
const schema = z.object({ mint: z.string().trim().min(32).max(44), side: z.enum(["buy", "sell"]), wallet: z.string().trim().min(32).max(44), amount: z.string().trim().min(1).max(30), slippageBps: z.number().int().min(10).max(2_000).default(300) }).strict();
export async function POST(request: Request) {
  const limited = await enforceWriteRateLimit(request, "manual-prepare", 20); if (limited) return limited;
  try {
    return NextResponse.json(await prepareManualTrade(schema.parse(await request.json())));
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Dữ liệu lệnh không hợp lệ." }, { status: 422 });
    if (error instanceof ManualTradeError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof WalletAddressError) return NextResponse.json({ error: error.message }, { status: 422 });
    console.error("Manual prepare failed", error);
    return NextResponse.json({ error: `Không thể chuẩn bị giao dịch: ${error instanceof Error ? error.message : String(error)}` }, { status: 503 });
  }
}
