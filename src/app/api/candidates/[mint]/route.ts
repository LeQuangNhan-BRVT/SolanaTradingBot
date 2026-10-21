import { NextResponse } from "next/server";
import { z } from "zod";
import { getCandidateDetail, updateWatchlist, WatchlistError } from "@/db/repository";
import { enforceWriteRateLimit } from "@/lib/api-security";
import { watchlistPatchSchema } from "@/lib/watchlist";
import { unscheduleTokenJobs } from "@/queue/client";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ mint: string }> }) { const { mint } = await context.params; const detail = await getCandidateDetail(mint); return detail ? NextResponse.json(detail) : NextResponse.json({ error: "Không tìm thấy token." }, { status: 404 }); }
export async function PATCH(request: Request, context: { params: Promise<{ mint: string }> }) {
  const limited = await enforceWriteRateLimit(request, "watchlist", 60); if (limited) return limited;
  const { mint } = await context.params;
  try {
    const patch = watchlistPatchSchema.parse(await request.json());
    const row = await updateWatchlist(mint, patch);
    // Restoring is done by re-submitting the CA, which re-verifies the token and reschedules its jobs.
    const unscheduled = patch.archived === true ? await unscheduleTokenJobs(mint).catch((error) => { console.error("Unable to unschedule token jobs", error); return null; }) : null;
    return NextResponse.json({ message: patch.archived === true ? "Đã lưu trữ token và dừng cập nhật nền." : "Đã cập nhật watchlist.", token: { mint: row.mint, pinned: row.pinned, archived: row.archivedAt !== null, autoTrade: row.autoTrade, tags: row.watchTags, note: row.watchNote }, unscheduled });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Dữ liệu watchlist không hợp lệ." }, { status: 422 });
    if (error instanceof WatchlistError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Watchlist update failed", error);
    return NextResponse.json({ error: "Không thể cập nhật watchlist." }, { status: 503 });
  }
}
