import { NextResponse } from "next/server";
import { cancelTriggerOrder } from "@/db/repository";
import { enforceWriteRateLimit } from "@/lib/api-security";
export const runtime = "nodejs";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const limited = await enforceWriteRateLimit(request, "triggers", 30); if (limited) return limited;
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Mã lệnh không hợp lệ." }, { status: 422 });
  return await cancelTriggerOrder(id) ? NextResponse.json({ message: "Đã hủy lệnh." }) : NextResponse.json({ error: "Lệnh không còn ở trạng thái chờ." }, { status: 409 });
}
