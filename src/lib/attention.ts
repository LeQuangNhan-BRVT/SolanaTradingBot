import { evaluateWatchAlerts, type WatchAlertConfig } from "./watchlist";
import { TRIGGER_LABELS, type TriggerType } from "./triggers";

export type AttentionTone = "danger" | "warning" | "info";
export type AttentionItem = { id: string; tone: AttentionTone; title: string; detail: string; href: string; action: string; at: string | null };

export type AttentionData = {
  triggeredAlerts: Array<{ id: string; mint: string; symbol: string; type: string; sellPctBps: number | null; triggeredAt: Date | null }>;
  pendingOrders: Array<{ id: string; mint: string; symbol: string; side: string; status: string; origin: string; updatedAt: Date }>;
  failedOrders: Array<{ id: string; mint: string; symbol: string; side: string; mode: string; error: string | null; updatedAt: Date }>;
  triggerEvents: Array<{ id: string; mint: string; symbol: string; type: string; status: string; mode: string; lastError: string | null; at: Date }>;
  priceAlerts: Array<WatchAlertConfig & { priceUsd: string | null; priceChange1h: string | null }>;
  discovery: Array<{ mint: string; symbol: string | null; status: string; at: Date }>;
};

const TONE_ORDER: Record<AttentionTone, number> = { danger: 0, warning: 1, info: 2 };
const label = (type: string) => TRIGGER_LABELS[type as TriggerType] ?? type;
const side = (value: string) => value === "buy" ? "Mua" : "Bán";
const iso = (value: Date | null) => value?.toISOString() ?? null;

// Turns raw rows into one list ordered by urgency (things that need the user's hand first), then newest first.
export function buildAttentionItems(data: AttentionData): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const alert of data.triggeredAlerts) {
    const pct = (alert.sellPctBps ?? 10_000) / 100;
    items.push({ id: `alert-${alert.id}`, tone: "danger", title: `${label(alert.type)} ${alert.symbol} đã chạm ngưỡng`, detail: `Cần bạn bán ${pct.toFixed(0)}% vị thế từ ví trình duyệt.`, href: `/tokens/${alert.mint}?sell=${pct}#manual-trade`, action: "Bán ngay", at: iso(alert.triggeredAt) });
  }
  for (const order of data.pendingOrders) items.push({ id: `pending-${order.id}`, tone: "warning", title: `Lệnh ${side(order.side).toLowerCase()} ${order.symbol} chưa xác nhận`, detail: `Trạng thái ${order.status}${order.origin === "manual" ? " · ví trình duyệt" : ""}; job phục hồi đang theo dõi.`, href: `/tokens/${order.mint}#history`, action: "Xem", at: iso(order.updatedAt) });
  for (const order of data.failedOrders) items.push({ id: `failed-${order.id}`, tone: "warning", title: `Lệnh ${side(order.side).toLowerCase()} ${order.symbol} thất bại`, detail: `${order.mode}${order.error ? ` · ${order.error}` : ""}`, href: `/tokens/${order.mint}#history`, action: "Xem", at: iso(order.updatedAt) });
  for (const event of data.triggerEvents) {
    const filled = event.status === "filled";
    items.push({ id: `trigger-${event.id}`, tone: filled ? "info" : "warning", title: `${label(event.type)} ${event.symbol} ${filled ? "đã khớp" : event.status === "failed" ? "thất bại" : "hết hạn"}`, detail: filled ? `Lệnh điều kiện ${event.mode} đã thực hiện.` : event.lastError ?? `Lệnh điều kiện ${event.mode}.`, href: `/tokens/${event.mint}#triggers`, action: "Xem", at: iso(event.at) });
  }
  for (const config of data.priceAlerts) {
    const fired = evaluateWatchAlerts(config, { priceUsd: config.priceUsd, priceChange1h: config.priceChange1h === null ? null : Number(config.priceChange1h) });
    for (const alert of fired) items.push({ id: `price-${config.mint}-${alert.kind}`, tone: "info", title: `Cảnh báo giá ${config.symbol}`, detail: alert.message, href: `/tokens/${config.mint}#watch`, action: "Xem", at: null });
  }
  const name = (token: AttentionData["discovery"][number]) => token.symbol ?? `${token.mint.slice(0, 6)}…`;
  for (const token of data.discovery.filter((row) => row.status === "promoted")) items.push({ id: `disc-${token.mint}`, tone: "info", title: `${name(token)} mới vào watchlist`, detail: "Token migrate vừa đạt preset lọc.", href: `/tokens/${token.mint}`, action: "Xem", at: iso(token.at) });
  // Auto-archives can come in bursts, so they are folded into one item.
  const archived = data.discovery.filter((row) => row.status === "archived").sort((a, b) => b.at.getTime() - a.at.getTime());
  if (archived.length) {
    const names = archived.slice(0, 4).map(name).join(", ") + (archived.length > 4 ? ` và ${archived.length - 4} token khác` : "");
    items.push({ id: "disc-archived", tone: "info", title: archived.length === 1 ? `${names} đã tự lưu trữ` : `${archived.length} token đã tự lưu trữ`, detail: `${archived.length === 1 ? "" : `${names}. `}Không còn đạt preset lọc; có thể khôi phục trong tab Lưu trữ.`, href: "/?view=archived#watchlist", action: "Lưu trữ", at: iso(archived[0].at) });
  }
  return items.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || (b.at ?? "").localeCompare(a.at ?? ""));
}
