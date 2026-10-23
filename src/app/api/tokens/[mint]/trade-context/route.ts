import { NextResponse } from "next/server";
import { getTradingControls, getTriggerContext, listTriggerOrders } from "@/db/repository";
import { manualTradingConfigError } from "@/lib/manual-trading";
export const runtime = "nodejs";

// Everything the quick-trade drawer needs to render the manual trade panel for one token.
export async function GET(_request: Request, context: { params: Promise<{ mint: string }> }) {
  const { mint } = await context.params;
  const [ctx, triggers, controls] = await Promise.all([getTriggerContext(mint), listTriggerOrders({ mint }), getTradingControls()]);
  if (!ctx) return NextResponse.json({ error: "Token chưa có trong watchlist." }, { status: 404 });
  const disabledReason = manualTradingConfigError();
  return NextResponse.json({
    mint, symbol: ctx.token.symbol, name: ctx.token.name, decimals: ctx.token.decimals, enabled: !disabledReason, disabledReason, halted: controls.haltAll,
    positions: ctx.walletPositions.map((position) => ({ wallet: position.wallet, quantityRaw: position.quantityRaw, costLamports: position.costLamports })),
    alerts: triggers.filter((order) => order.mode === "live" && order.status === "triggered").map((order) => ({ id: order.id, type: order.type, sellPctBps: order.sellPctBps })),
  });
}
