import test from "node:test";
import assert from "node:assert/strict";
import { buildAttentionItems, type AttentionData } from "../src/lib/attention";

const empty: AttentionData = { triggeredAlerts: [], pendingOrders: [], failedOrders: [], triggerEvents: [], priceAlerts: [], discovery: [] };
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

test("fired TP/SL alerts come first and link to a prefilled sell", () => {
  const items = buildAttentionItems({
    ...empty,
    discovery: [{ mint: "M1", symbol: "NEW", status: "promoted", at: at(1) }],
    failedOrders: [{ id: "o1", mint: "M2", symbol: "BAD", side: "buy", mode: "shadow", error: "slippage", updatedAt: at(2) }],
    triggeredAlerts: [{ id: "t1", mint: "M3", symbol: "HOT", type: "take_profit", sellPctBps: 5_000, triggeredAt: at(30) }],
  });
  assert.deepEqual(items.map((item) => item.tone), ["danger", "warning", "info"]);
  assert.equal(items[0].href, "/tokens/M3?sell=50#manual-trade");
  assert.match(items[0].detail, /50%/);
});

test("within a tone the newest item is first", () => {
  const items = buildAttentionItems({ ...empty, discovery: [{ mint: "A", symbol: "OLD", status: "promoted", at: at(120) }, { mint: "B", symbol: "NEW", status: "promoted", at: at(5) }] });
  assert.deepEqual(items.map((item) => item.id), ["disc-B", "disc-A"]);
});

test("auto-archived tokens are folded into one item", () => {
  const discovery = ["A", "B", "C", "D", "E", "F"].map((symbol, index) => ({ mint: `M${symbol}`, symbol, status: "archived", at: at(index) }));
  const items = buildAttentionItems({ ...empty, discovery });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "6 token đã tự lưu trữ");
  assert.match(items[0].detail, /^A, B, C, D và 2 token khác\./);
  assert.equal(items[0].href, "/?view=archived#watchlist");
});

test("price alerts appear only while the threshold is crossed", () => {
  const config = { mint: "P", symbol: "PX", alertPriceAboveUsd: "0.010000000000000000", alertPriceBelowUsd: null, alertChange1hPct: "20.0000" };
  assert.equal(buildAttentionItems({ ...empty, priceAlerts: [{ ...config, priceUsd: "0.005000000000000000", priceChange1h: "3" }] }).length, 0);
  const fired = buildAttentionItems({ ...empty, priceAlerts: [{ ...config, priceUsd: "0.020000000000000000", priceChange1h: "-25" }] });
  assert.deepEqual(fired.map((item) => item.id), ["price-P-price_above", "price-P-change_1h"]);
  assert.equal(fired[0].detail, "PX giá $0.02 ≥ ngưỡng $0.01.", "padded Postgres numerics are trimmed");
  assert.match(fired[1].detail, /ngưỡng ±20%/);
});
