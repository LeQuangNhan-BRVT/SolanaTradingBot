import { NextResponse } from "next/server";
import { z } from "zod";
import { MintValidationError } from "@/lib/solana";
import { enforceWriteRateLimit } from "@/lib/api-security";
import { assessAndSaveCandidate } from "@/lib/candidate-assessment";
export const runtime = "nodejs";
const requestSchema = z.object({ mint: z.string().trim().min(32).max(44) });
export async function POST(request: Request) {const limited=await enforceWriteRateLimit(request,"candidate",10);if(limited)return limited;
  try {
    const input = requestSchema.parse(await request.json());
    const { candidate, mint, checks, persisted } = await assessAndSaveCandidate(input.mint);
    return NextResponse.json({ message: candidate.status === "rejected" ? "CA hợp lệ nhưng không vượt qua hard gate." : "Đã xác minh mint. Holder và bundle analysis đang chạy nền.", persisted, assessment: { candidate, mint, checks, summary: "Fail-closed: chưa giao dịch khi còn kiểm tra quan trọng chưa xác minh." } }, { status: 202 });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof MintValidationError) return NextResponse.json({ error: error instanceof MintValidationError ? error.message : "CA Solana không hợp lệ." }, { status: 422 });
    console.error("Mint inspection failed", error);
    return NextResponse.json({ error: "Không thể truy vấn Solana RPC hoặc database. Vui lòng thử lại.", ...(process.env.NODE_ENV === "development" ? { detail: error instanceof Error ? error.message : String(error) } : {}) }, { status: 503 });
  }
}
