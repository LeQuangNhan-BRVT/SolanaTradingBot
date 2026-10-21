import { NextResponse } from "next/server";
import { deleteTrackedWallet } from "@/db/repository";
import { enforceWriteRateLimit } from "@/lib/api-security";
export const runtime = "nodejs";
export async function DELETE(request: Request, context: { params: Promise<{ address: string }> }) {
  const limited = await enforceWriteRateLimit(request, "wallets", 20); if (limited) return limited;
  const { address } = await context.params;
  return await deleteTrackedWallet(address) ? NextResponse.json({ message: "Đã xóa ví khỏi danh sách theo dõi." }) : NextResponse.json({ error: "Không tìm thấy ví." }, { status: 404 });
}
