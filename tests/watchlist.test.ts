import test from "node:test";
import assert from "node:assert/strict";
import { compareDecimal, evaluateWatchAlerts, normalizeTags, watchlistPatchSchema } from "../src/lib/watchlist";

const config = { mint: "m", symbol: "TEST", alertPriceAboveUsd: "0.002000000000000000", alertPriceBelowUsd: "0.0005", alertChange1hPct: "25.0000" };

test("decimal comparison is exact for tiny prices", () => {
  assert.equal(compareDecimal("0.000000000000000002", "0.000000000000000001"), 1);
  assert.equal(compareDecimal("0.0015", "0.001500000"), 0);
  assert.equal(compareDecimal("1", "0.9999999999"), 1);
});

test("price alerts trigger at thresholds", () => {
  assert.deepEqual(evaluateWatchAlerts(config, { priceUsd: "0.002", priceChange1h: 3 }).map((item) => item.kind), ["price_above"]);
  assert.deepEqual(evaluateWatchAlerts(config, { priceUsd: "0.0005", priceChange1h: null }).map((item) => item.kind), ["price_below"]);
  assert.deepEqual(evaluateWatchAlerts(config, { priceUsd: "0.001", priceChange1h: -30 }).map((item) => item.kind), ["change_1h"]);
});

test("no alert without price data or thresholds", () => {
  assert.deepEqual(evaluateWatchAlerts(config, { priceUsd: null, priceChange1h: null }), []);
  assert.deepEqual(evaluateWatchAlerts({ ...config, alertPriceAboveUsd: null, alertPriceBelowUsd: null, alertChange1hPct: null }, { priceUsd: "9", priceChange1h: 90 }), []);
});

test("tags are normalized and deduplicated", () => {
  assert.deepEqual(normalizeTags([" Meme ", "meme", "chờ dip", "", "x".repeat(30)]), ["meme", "chờ-dip"]);
});

test("patch schema rejects unarchive, unknown fields and bad prices", () => {
  assert.equal(watchlistPatchSchema.safeParse({ archived: false }).success, false);
  assert.equal(watchlistPatchSchema.safeParse({ privateKey: "x" }).success, false);
  assert.equal(watchlistPatchSchema.safeParse({ alertPriceAboveUsd: "1e-5" }).success, false);
  assert.equal(watchlistPatchSchema.safeParse({ alertPriceAboveUsd: "0.00001", pinned: true, tags: ["a"] }).success, true);
});
