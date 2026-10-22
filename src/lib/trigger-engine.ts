import { claimTriggerOrder, fillTriggerBuy, fillTriggerSell, getShadowPortfolioState, getShadowPositionById, getShadowSettings, listActiveTriggersForPricing, recordTriggerObservation, releaseTriggerOrder } from "@/db/repository";
import { getJupiterQuote } from "./shadow";
import { fetchJupiterPrices } from "./price-feed";
import { assessPortfolioRisk } from "./strategy";
import { confirmTriggerQuote, evaluateTrigger, formatMcap, impliedMcapFromQuote, mcapFromPrice, sellAmountRaw, TRIGGER_LABELS, TriggerRejectedError, type TriggerType } from "./triggers";
import { WSOL_MINT } from "./wallet-tracker";
import { sendAlertOnce } from "./alerts";

// Trigger orders are simulated (shadow) and only evaluated while the worker runs in shadow mode.
export const triggersEnabled = () => (process.env.TRADING_MODE ?? "paper") === "shadow";

type ActiveTrigger = Awaited<ReturnType<typeof listActiveTriggersForPricing>>[number];

export async function scanTriggerOrders(triggers: ActiveTrigger[], prices: Map<string, number>, requestExecute: (triggerId: string) => Promise<void>) {
  let fired = 0;
  for (const trigger of triggers) {
    const priceUsd = prices.get(trigger.mint);
    if (priceUsd === undefined || trigger.supplyRaw === null || trigger.decimals === null) continue;
    const mcap = mcapFromPrice(priceUsd, trigger.supplyRaw, trigger.decimals);
    const result = evaluateTrigger({ type: trigger.type, triggerMcapUsd: trigger.triggerMcapUsd === null ? null : Number(trigger.triggerMcapUsd), trailingBps: trigger.trailingBps, peakMcapUsd: trigger.peakMcapUsd === null ? null : Number(trigger.peakMcapUsd) }, mcap);
    await recordTriggerObservation(trigger.id, mcap, trigger.type === "trailing_stop" ? result.peakMcapUsd : null);
    if (!result.fire) continue;
    fired++;
    await requestExecute(trigger.id);
  }
  return { checked: triggers.length, fired };
}

// Re-validates a fired trigger with an exact Jupiter quote and fills it as a simulated order.
export async function executeTriggerOrder(triggerId: string) {
  const claimed = await claimTriggerOrder(triggerId);
  if (!claimed) return { triggerId, skipped: true, reason: "Not active." };
  const { order, token } = claimed, label = TRIGGER_LABELS[order.type as TriggerType];
  // Browser-wallet positions: the app holds no key, so the order stays `triggered` until the user sells with one click.
  if (order.mode === "live") {
    const link = `${process.env.APP_ORIGIN ?? "http://127.0.0.1:3000"}/tokens/${token?.mint}?sell=${(order.sellPctBps ?? 10_000) / 100}#manual-trade`;
    void sendAlertOnce(`trigger-alert:${order.id}`, 24 * 60 * 60_000, { type: "trigger.alert", severity: order.type === "take_profit" ? "info" : "warning", title: `${label} ${token?.symbol ?? ""} chạm ngưỡng — cần bạn bán`, message: `Bán ${((order.sellPctBps ?? 10_000) / 100).toFixed(0)}% từ ví trình duyệt: ${link}`, data: { triggerId: order.id, link } });
    return { triggerId, alerted: true, link };
  }
  if (!triggersEnabled()) { await releaseTriggerOrder(order.id, "TRADING_MODE is not shadow."); return { triggerId, skipped: true, reason: "TRADING_MODE is not shadow." }; }
  try {
    if (!token || token.supplyRaw === null || token.decimals === null) throw new TriggerRejectedError("Token thiếu supply/decimals để tính market cap.");
    const solUsd = (await fetchJupiterPrices([WSOL_MINT])).get(WSOL_MINT);
    if (!solUsd) throw new Error("Không lấy được giá SOL.");
    const target = { type: order.type as TriggerType, triggerMcapUsd: order.triggerMcapUsd === null ? null : Number(order.triggerMcapUsd), maxSlippageBps: order.maxSlippageBps };

    if (order.type === "limit_buy") {
      if (!order.buyLamports) throw new TriggerRejectedError("Thiếu khối lượng mua.");
      const settings = await getShadowSettings();
      // Manual orders respect open-position, exposure and daily-loss limits but not the bot's cooldown or loss streak.
      const portfolio = assessPortfolioRisk(await getShadowPortfolioState(token.mint), { ...settings, entryLamports: Number(order.buyLamports), reentryCooldownMinutes: 0, maxConsecutiveLosses: Number.MAX_SAFE_INTEGER });
      if (!portfolio.accepted) { await releaseTriggerOrder(order.id, portfolio.reasons.join(" ")); return { triggerId, filled: false, reason: portfolio.reasons.join(" ") }; }
      const quote = await getJupiterQuote(WSOL_MINT, token.mint, order.buyLamports, order.maxSlippageBps);
      const implied = impliedMcapFromQuote(quote, "buy", token.decimals, token.supplyRaw, solUsd);
      const check = confirmTriggerQuote(target, implied, quote.priceImpactPct);
      if (!check.ok) { await releaseTriggerOrder(order.id, check.reason!); return { triggerId, filled: false, reason: check.reason }; }
      const filled = await fillTriggerBuy(order.id, quote, implied!);
      void sendAlertOnce(`trigger-filled:${order.id}`, 24 * 60 * 60_000, { type: "trigger.filled", severity: "info", title: `${label} ${token.symbol} khớp (shadow)`, message: `Mua ${quote.inAmount} lamports tại mcap ${formatMcap(implied)}.`, data: { triggerId: order.id, ...filled } });
      return { triggerId, filled: true, impliedMcapUsd: implied, ...filled };
    }

    if (!order.positionId || !order.sellPctBps) throw new TriggerRejectedError("Lệnh bán thiếu vị thế hoặc tỷ lệ bán.");
    const position = await getShadowPositionById(order.positionId);
    if (!position || position.status !== "open") throw new TriggerRejectedError("Vị thế không còn mở.");
    const soldRaw = sellAmountRaw(position.quantityRaw, order.sellPctBps);
    if (soldRaw <= 0n) throw new TriggerRejectedError("Khối lượng bán bằng 0.");
    const quote = await getJupiterQuote(token.mint, WSOL_MINT, soldRaw.toString(), order.maxSlippageBps);
    const implied = impliedMcapFromQuote(quote, "sell", token.decimals, token.supplyRaw, solUsd);
    const check = confirmTriggerQuote(target, implied, quote.priceImpactPct);
    if (!check.ok) {
      await releaseTriggerOrder(order.id, check.reason!);
      if (order.type !== "take_profit") void sendAlertOnce(`trigger-blocked:${order.id}`, 30 * 60_000, { type: "trigger.blocked", severity: "warning", title: `${label} ${token.symbol} chưa khớp`, message: check.reason!, data: { triggerId: order.id } });
      return { triggerId, filled: false, reason: check.reason };
    }
    const filled = await fillTriggerSell(order.id, quote, soldRaw, implied!);
    void sendAlertOnce(`trigger-filled:${order.id}`, 24 * 60 * 60_000, { type: "trigger.filled", severity: order.type === "take_profit" ? "info" : "warning", title: `${label} ${token.symbol} khớp (shadow)`, message: `Bán ${(order.sellPctBps / 100).toFixed(0)}% tại mcap ${formatMcap(implied)}, PnL ${(filled.pnlBps / 100).toFixed(2)}%.`, data: { triggerId: order.id, ...filled } });
    return { triggerId, filled: true, impliedMcapUsd: implied, ...filled };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await releaseTriggerOrder(order.id, message, error instanceof TriggerRejectedError ? "failed" : "active");
    return { triggerId, filled: false, error: message };
  }
}
