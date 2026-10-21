import { NextResponse } from "next/server";
import { z } from "zod";
import { listTrackedWallets, saveTrackedWallet } from "@/db/repository";
import { enforceWriteRateLimit } from "@/lib/api-security";
import { parseWalletAddress, WalletAddressError } from "@/lib/wallet-tracker";
export const runtime = "nodejs";
const schema = z.object({ address: z.string().trim().min(32).max(44), label: z.string().trim().max(60).nullable().optional() }).strict();
export async function GET() { return NextResponse.json({ wallets: await listTrackedWallets() }); }
export async function POST(request: Request) {
  const limited = await enforceWriteRateLimit(request, "wallets", 20); if (limited) return limited;
  try {
    const input = schema.parse(await request.json());
    const wallet = await saveTrackedWallet(parseWalletAddress(input.address), input.label || null);
    return NextResponse.json({ message: "Đã thêm ví theo dõi (chỉ xem, không lưu private key).", wallet }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof WalletAddressError) return NextResponse.json({ error: error instanceof WalletAddressError ? error.message : "Địa chỉ ví không hợp lệ." }, { status: 422 });
    console.error("Tracked wallet save failed", error);
    return NextResponse.json({ error: "Không thể lưu ví." }, { status: 503 });
  }
}
