import { NextResponse } from "next/server";
import { getCandidateDetail } from "@/db/repository";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ mint: string }> }) { const { mint } = await context.params; const detail = await getCandidateDetail(mint); return detail ? NextResponse.json(detail) : NextResponse.json({ error: "Không tìm thấy token." }, { status: 404 }); }
