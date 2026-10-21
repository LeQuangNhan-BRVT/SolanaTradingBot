import test from "node:test";
import assert from "node:assert/strict";
import { confirmTriggerQuote, costPortion, createTriggerSchema, evaluateTrigger, formatMcap, impliedMcapFromQuote, mcapFromPrice, parseMcapInput, sellAmountRaw, solToLamports, validateAgainstMarket } from "../src/lib/triggers";

test("market cap input accepts suffixes and separators", () => {
  assert.equal(parseMcapInput("5M"), 5_000_000);
  assert.equal(parseMcapInput("$2.5m"), 2_500_000);
  assert.equal(parseMcapInput("750k"), 750_000);
  assert.equal(parseMcapInput("1,500,000"), 1_500_000);
  assert.equal(parseMcapInput("1.2B"), 1_200_000_000);
  assert.equal(parseMcapInput("abc"), null);
  assert.equal(parseMcapInput("0"), null);
  assert.equal(formatMcap(2_500_000), "$2.50M");
});

test("market cap is price times on-chain supply", () => {
  // 1B tokens with 6 decimals at $0.005 = $5M.
  assert.equal(mcapFromPrice(0.005, "1000000000000000", 6), 5_000_000);
});

test("SOL amounts convert to lamports exactly", () => {
  assert.equal(solToLamports("0.05"), 50_000_000n);
  assert.equal(solToLamports("1.123456789"), 1_123_456_789n);
  assert.equal(solToLamports("1.1234567891"), null);
  assert.equal(solToLamports("0"), null);
  assert.equal(solToLamports("-1"), null);
});

test("limit buy, take profit and stop loss fire at their thresholds", () => {
  const at = (type: "limit_buy" | "take_profit" | "stop_loss", trigger: number, mcap: number) => evaluateTrigger({ type, triggerMcapUsd: trigger, trailingBps: null, peakMcapUsd: null }, mcap).fire;
  assert.equal(at("limit_buy", 1_000_000, 1_000_000), true);
  assert.equal(at("limit_buy", 1_000_000, 1_000_001), false);
  assert.equal(at("take_profit", 5_000_000, 5_000_000), true);
  assert.equal(at("take_profit", 5_000_000, 4_999_999), false);
  assert.equal(at("stop_loss", 800_000, 799_000), true);
  assert.equal(at("stop_loss", 800_000, 900_000), false);
});

test("trailing stop ratchets its peak and fires after the configured drop", () => {
  let state = { type: "trailing_stop" as const, triggerMcapUsd: null, trailingBps: 2_000, peakMcapUsd: 1_000_000 };
  let result = evaluateTrigger(state, 1_500_000);
  assert.deepEqual(result, { fire: false, peakMcapUsd: 1_500_000 });
  state = { ...state, peakMcapUsd: result.peakMcapUsd };
  assert.equal(evaluateTrigger(state, 1_250_000).fire, false);
  result = evaluateTrigger(state, 1_200_000);
  assert.equal(result.fire, true);
  assert.equal(result.peakMcapUsd, 1_500_000);
});

test("implied market cap from buy and sell quotes", () => {
  // 1 SOL ($100) buys 20,000 tokens -> $0.005 each; 1B supply (6 decimals) -> $5M.
  assert.equal(impliedMcapFromQuote({ inAmount: "1000000000", outAmount: "20000000000" }, "buy", 6, "1000000000000000", 100), 5_000_000);
  assert.equal(impliedMcapFromQuote({ inAmount: "20000000000", outAmount: "1000000000" }, "sell", 6, "1000000000000000", 100), 5_000_000);
  assert.equal(impliedMcapFromQuote({ inAmount: "1", outAmount: "0" }, "buy", 6, "1", 100), null);
});

test("limit fills only at or better than its price; stops respect max price impact", () => {
  assert.equal(confirmTriggerQuote({ type: "limit_buy", triggerMcapUsd: 1_000_000, maxSlippageBps: 300 }, 990_000, "0.01").ok, true);
  assert.equal(confirmTriggerQuote({ type: "limit_buy", triggerMcapUsd: 1_000_000, maxSlippageBps: 300 }, 1_010_000, "0.01").ok, false);
  assert.equal(confirmTriggerQuote({ type: "take_profit", triggerMcapUsd: 5_000_000, maxSlippageBps: 300 }, 4_900_000, "0.01").ok, false);
  assert.equal(confirmTriggerQuote({ type: "stop_loss", triggerMcapUsd: 800_000, maxSlippageBps: 300 }, 700_000, "0.02").ok, true);
  assert.equal(confirmTriggerQuote({ type: "stop_loss", triggerMcapUsd: 800_000, maxSlippageBps: 300 }, 700_000, "0.05").ok, false);
});

test("partial sells release proportional cost basis", () => {
  assert.equal(sellAmountRaw("1000", 5_000), 500n);
  assert.equal(sellAmountRaw("999", 10_000), 999n);
  assert.equal(costPortion("100000000", "1000", 250n), 25_000_000n);
  assert.equal(costPortion("100000000", "1000", 1000n), 100_000_000n);
});

test("orders that would fire immediately are rejected", () => {
  const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const parse = (body: unknown) => createTriggerSchema.parse(body);
  assert.equal(validateAgainstMarket(parse({ type: "limit_buy", mint, triggerMcapUsd: 2_000_000, buySol: "0.1" }), 1_000_000).length, 1);
  assert.equal(validateAgainstMarket(parse({ type: "take_profit", mint, triggerMcapUsd: 900_000, sellPct: 50 }), 1_000_000).length, 1);
  assert.equal(validateAgainstMarket(parse({ type: "bracket", mint, takeProfitMcapUsd: 2_000_000, stopLossMcapUsd: 800_000, sellPct: 100 }), 1_000_000).length, 0);
  assert.equal(createTriggerSchema.safeParse({ type: "trailing_stop", mint, trailingPct: 95, sellPct: 100 }).success, false);
});
