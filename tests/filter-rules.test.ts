import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRESET, evaluateGroup, evaluateRule, feeStopTarget, fieldsUsed, filterGroupSchema, type FilterGroup } from "../src/lib/filter-rules";

test("numeric operators and between", () => {
  assert.equal(evaluateRule({ field: "volume24hUsd", op: "gte", value: 20_000 }, { volume24hUsd: 20_000 }).outcome, "pass");
  assert.equal(evaluateRule({ field: "top10Pct", op: "lt", value: 30 }, { top10Pct: 30 }).outcome, "fail");
  assert.equal(evaluateRule({ field: "mcapUsd", op: "between", value: 1e6, value2: 1e7 }, { mcapUsd: 5e6 }).outcome, "pass");
  assert.equal(evaluateRule({ field: "mcapUsd", op: "between", value: 1e6, value2: 1e7 }, { mcapUsd: 2e7 }).outcome, "fail");
  assert.equal(evaluateRule({ field: "top10Pct", op: "lt", value: 30 }, {}).outcome, "unknown");
});

test("boolean flags", () => {
  assert.equal(evaluateRule({ field: "dexPaid", op: "eq", value: true }, { dexPaid: true }).outcome, "pass");
  assert.equal(evaluateRule({ field: "cto", op: "eq", value: true }, { cto: false }).outcome, "fail");
});

test("lower-bound fees can pass early but never fail an at-least rule", () => {
  assert.equal(evaluateRule({ field: "totalFeesSol", op: "gt", value: 10 }, { totalFeesSol: { lowerBound: 12 } }).outcome, "pass");
  assert.equal(evaluateRule({ field: "totalFeesSol", op: "gt", value: 10 }, { totalFeesSol: { lowerBound: 4 } }).outcome, "unknown");
  assert.equal(evaluateRule({ field: "totalFeesSol", op: "lt", value: 10 }, { totalFeesSol: { lowerBound: 12 } }).outcome, "fail");
});

test("three-valued AND/OR with nested groups", () => {
  const group: FilterGroup = { match: "all", rules: [{ field: "volume24hUsd", op: "gte", value: 20_000 }, { match: "any", rules: [{ field: "dexPaid", op: "eq", value: true }, { field: "boosts", op: "gt", value: 0 }] }] };
  assert.equal(evaluateGroup(group, { volume24hUsd: 30_000, dexPaid: false, boosts: 2 }).outcome, "pass");
  assert.equal(evaluateGroup(group, { volume24hUsd: 10_000 }).outcome, "fail");
  assert.equal(evaluateGroup(group, { volume24hUsd: 30_000, dexPaid: false }).outcome, "unknown");
});

test("a cheap failure decides the default preset without expensive data", () => {
  const result = evaluateGroup(DEFAULT_PRESET.rules, { volume24hUsd: 5_000 });
  assert.equal(result.outcome, "fail");
  assert.equal(evaluateGroup(DEFAULT_PRESET.rules, { volume24hUsd: 50_000, top10Pct: 20, bundlePct: 5, totalFeesSol: { lowerBound: 11 } }).outcome, "pass");
});

test("fields used and fee stop target", () => {
  assert.deepEqual([...fieldsUsed(DEFAULT_PRESET.rules)].sort(), ["bundlePct", "top10Pct", "totalFeesSol", "volume24hUsd"]);
  assert.equal(feeStopTarget(DEFAULT_PRESET.rules), 10);
  assert.equal(feeStopTarget({ match: "all", rules: [{ field: "volume24hUsd", op: "gte", value: 1 }] }), null);
});

test("schema rejects malformed or oversized presets", () => {
  assert.equal(filterGroupSchema.safeParse(DEFAULT_PRESET.rules).success, true);
  assert.equal(filterGroupSchema.safeParse({ match: "all", rules: [] }).success, false);
  assert.equal(filterGroupSchema.safeParse({ match: "all", rules: [{ field: "dexPaid", op: "gt", value: 1 }] }).success, false);
  assert.equal(filterGroupSchema.safeParse({ match: "all", rules: [{ field: "eval", op: "gt", value: 1 }] }).success, false);
  const deep = { match: "all", rules: [{ match: "all", rules: [{ match: "all", rules: [{ match: "all", rules: [{ field: "boosts", op: "gt", value: 0 }] }] }] }] };
  assert.equal(filterGroupSchema.safeParse(deep).success, false);
});
