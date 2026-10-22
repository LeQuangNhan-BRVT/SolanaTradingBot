import { NextResponse } from "next/server";
import { z } from "zod";
import { cancelManualOrder, getManualOrder } from "@/db/repository";
import { enforceWriteRateLimit } from "@/lib/api-security";
import { ManualTradeError, submitManualTrade } from "@/lib/manual-trading";
export const runtime = "nodejs";
// Waiting for confirmation can take up to ~45s.
export const maxDuration = 60;
const schema = z.discriminatedUnion("action", [z.object({ action: z.literal("submit"), signature: z.string().trim().min(64).max(90) }), z.object({ action: z.literal("cancel") })]);

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const order = await getManualOrder((await context.params).id);
  return order ? NextResponse.json({ ...order, lastValidBlockHeight: order.lastValidBlockHeight?.toString() ?? null }) : NextResponse.json({ error: "Không tìm thấy lệnh." }, { status: 404 });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const limited = await enforceWriteRateLimit(request, "manual-submit", 30); if (limited) return limited;
  const { id } = await context.params;
  try {
    const input = schema.parse(await request.json());
    if (input.action === "cancel") return await cancelManualOrder(id) ? NextResponse.json({ message: "Đã hủy lệnh chưa ký." }) : NextResponse.json({ error: "Lệnh đã ký hoặc không còn chờ; không thể hủy." }, { status: 409 });
    return NextResponse.json(await submitManualTrade(id, input.signature));
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 422 });
    if (error instanceof ManualTradeError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Manual submit failed", error);
    return NextResponse.json({ status: "pending", error: "Không xác nhận được ngay; job phục hồi sẽ tiếp tục theo dõi giao dịch." }, { status: 202 });
  }
}
