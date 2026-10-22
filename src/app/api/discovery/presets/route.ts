import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteFilterPreset, listFilterPresets, saveFilterPreset } from "@/db/repository";
import { enforceWriteRateLimit } from "@/lib/api-security";
import { filterGroupSchema } from "@/lib/filter-rules";
export const runtime = "nodejs";
const schema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(40), rules: filterGroupSchema, enabled: z.boolean(), autoPromote: z.boolean() }).strict();

export async function GET() { return NextResponse.json({ presets: await listFilterPresets() }); }

export async function POST(request: Request) {
  const limited = await enforceWriteRateLimit(request, "presets", 30); if (limited) return limited;
  try {
    const input = schema.parse(await request.json());
    const preset = await saveFilterPreset({ ...input, rules: input.rules as unknown as Record<string, unknown> });
    return preset ? NextResponse.json({ message: "Đã lưu preset.", preset }) : NextResponse.json({ error: "Không tìm thấy preset." }, { status: 404 });
  } catch (error) { return NextResponse.json({ error: error instanceof z.ZodError ? error.issues[0]?.message ?? "Preset không hợp lệ." : "Không thể lưu preset." }, { status: error instanceof z.ZodError ? 422 : 503 }); }
}

export async function DELETE(request: Request) {
  const limited = await enforceWriteRateLimit(request, "presets", 30); if (limited) return limited;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Mã preset không hợp lệ." }, { status: 422 });
  return await deleteFilterPreset(id) ? NextResponse.json({ message: "Đã xóa preset." }) : NextResponse.json({ error: "Không tìm thấy preset." }, { status: 404 });
}
