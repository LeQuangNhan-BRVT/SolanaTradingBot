import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createTriggerOrders, getTriggerContext, listTriggerOrders, type NewTriggerOrder } from "@/db/repository";
import { enforceWriteRateLimit } from "@/lib/api-security";
import { createTriggerSchema, formatMcap, mcapFromPrice, solToLamports, validateAgainstMarket } from "@/lib/triggers";
import { triggersEnabled } from "@/lib/trigger-engine";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const mint = new URL(request.url).searchParams.get("mint") ?? undefined;
  return NextResponse.json({ orders: await listTriggerOrders({ mint }) });
}

export async function POST(request: Request) {
  const limited = await enforceWriteRateLimit(request, "triggers", 30); if (limited) return limited;
  try {
    const input = createTriggerSchema.parse(await request.json());
    const context = await getTriggerContext(input.mint);
    if (!context) return NextResponse.json({ error: "Token chưa có trong watchlist. Hãy thêm CA trước." }, { status: 404 });
    const { token, priceUsd, position, walletPositions } = context;
    if (token.supplyRaw === null || token.decimals === null || priceUsd === null) return NextResponse.json({ error: "Chưa có giá hoặc supply để tính market cap; đợi lần làm mới market kế tiếp." }, { status: 422 });
    const currentMcap = mcapFromPrice(Number(priceUsd), token.supplyRaw, token.decimals);
    const errors = validateAgainstMarket(input, currentMcap);
    const warnings: string[] = [];

    // Sell orders attach to a shadow position (simulated fill) or a browser-wallet position (alert + one-click sell).
    const target = input.positionId ? (position?.id === input.positionId ? { id: position.id, mode: "shadow" as const } : walletPositions.some((item) => item.id === input.positionId) ? { id: input.positionId, mode: "live" as const } : null) : position ? { id: position.id, mode: "shadow" as const } : walletPositions[0] ? { id: walletPositions[0].id, mode: "live" as const } : null;
    if (input.positionId && !target) errors.push("Không tìm thấy vị thế đang mở được chọn.");
    if (!triggersEnabled() && (input.type === "limit_buy" || target?.mode !== "live")) warnings.push("Engine shadow chỉ chạy khi TRADING_MODE=shadow; lệnh sẽ chờ cho đến khi bật.");
    const base = { tokenId: token.id, mode: "shadow" as const, maxSlippageBps: input.maxSlippageBps, expiresAt: input.expiresInHours ? new Date(Date.now() + input.expiresInHours * 3_600_000) : null };
    let rows: NewTriggerOrder[] = [];
    if (input.type === "limit_buy") {
      const buyLamports = solToLamports(input.buySol);
      if (!buyLamports || buyLamports < 1_000_000n) errors.push("Khối lượng mua phải từ 0.001 SOL, tối đa 9 chữ số thập phân.");
      if (position) errors.push("Token đã có vị thế shadow đang mở; mỗi token chỉ một vị thế.");
      if (token.status !== "eligible") warnings.push(`Token đang ở trạng thái "${token.status}", chưa vượt hard gate. Lệnh vẫn được tạo theo lựa chọn của bạn — rủi ro cao.`);
      rows = [{ ...base, type: "limit_buy", triggerMcapUsd: input.triggerMcapUsd.toFixed(2), buyLamports: buyLamports?.toString() ?? null }];
    } else {
      if (!target) errors.push("Lệnh bán cần một vị thế đang mở (shadow hoặc ví trình duyệt) cho token này.");
      if (target?.mode === "live") warnings.push("Vị thế ví trình duyệt: khi chạm ngưỡng app chỉ gửi cảnh báo và nút \"Bán ngay\" — bạn cần ký trên ví để bán.");
      const sell = { ...base, mode: target?.mode ?? ("shadow" as const), positionId: target?.id ?? null, sellPctBps: Math.round(input.sellPct * 100) };
      if (input.type === "trailing_stop") rows = [{ ...sell, type: "trailing_stop", trailingBps: Math.round(input.trailingPct * 100), peakMcapUsd: currentMcap.toFixed(2) }];
      else if (input.type === "bracket") { const ocoGroup = randomUUID(); rows = [{ ...sell, type: "take_profit", triggerMcapUsd: input.takeProfitMcapUsd.toFixed(2), ocoGroup }, { ...sell, type: "stop_loss", triggerMcapUsd: input.stopLossMcapUsd.toFixed(2), ocoGroup }]; }
      else rows = [{ ...sell, type: input.type, triggerMcapUsd: input.triggerMcapUsd.toFixed(2) }];
    }
    if (errors.length) return NextResponse.json({ error: errors.join(" "), currentMcapUsd: currentMcap }, { status: 422 });
    const created = await createTriggerOrders(rows);
    return NextResponse.json({ message: `Đã tạo ${created.length} lệnh điều kiện (shadow). Market cap hiện tại ${formatMcap(currentMcap)}.`, warnings, orders: created.map((row) => row.id) }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Dữ liệu lệnh không hợp lệ." }, { status: 422 });
    console.error("Trigger create failed", error);
    return NextResponse.json({ error: "Không thể tạo lệnh điều kiện." }, { status: 503 });
  }
}
