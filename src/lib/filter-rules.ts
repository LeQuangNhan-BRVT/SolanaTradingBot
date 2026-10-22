import { z } from "zod";

// Fields a preset can filter on. Cost decides evaluation order: cheap data first, Helius-backed checks only when still needed.
export const FILTER_FIELDS = {
  volume24hUsd: { label: "Volume 24h (USD)", kind: "number", cost: "cheap" },
  liquidityUsd: { label: "Liquidity (USD)", kind: "number", cost: "cheap" },
  mcapUsd: { label: "Market cap (USD)", kind: "number", cost: "cheap" },
  priceChange1h: { label: "Biến động giá 1h (%)", kind: "number", cost: "cheap" },
  priceChange24h: { label: "Biến động giá 24h (%)", kind: "number", cost: "cheap" },
  buys24h: { label: "Số lệnh mua 24h", kind: "number", cost: "cheap" },
  sells24h: { label: "Số lệnh bán 24h", kind: "number", cost: "cheap" },
  buySellRatio24h: { label: "Tỷ lệ mua/bán 24h", kind: "number", cost: "cheap" },
  ageMinutes: { label: "Số phút từ khi migrate", kind: "number", cost: "cheap" },
  boosts: { label: "Số boost DexScreener", kind: "number", cost: "cheap" },
  hasSocials: { label: "Có website/social", kind: "boolean", cost: "cheap" },
  dexPaid: { label: "Đã pay DexScreener", kind: "boolean", cost: "cheap" },
  cto: { label: "Đã CTO", kind: "boolean", cost: "cheap" },
  top10Pct: { label: "Top 10 holder (%)", kind: "number", cost: "medium" },
  bundlePct: { label: "Bundle lúc launch (%)", kind: "number", cost: "expensive" },
  totalFeesSol: { label: "Total fees (SOL)", kind: "number", cost: "expensive" },
} as const;
export type FilterField = keyof typeof FILTER_FIELDS;
export type FieldCost = "cheap" | "medium" | "expensive";

export const OPERATORS = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=", between: "trong khoảng" } as const;
export type Operator = keyof typeof OPERATORS;

export type FilterRule = { field: FilterField; op: Operator; value: number | boolean; value2?: number };
export type FilterGroup = { match: "all" | "any"; rules: Array<FilterRule | FilterGroup> };

const fieldNames = Object.keys(FILTER_FIELDS) as [FilterField, ...FilterField[]];
const ruleSchema = z.object({ field: z.enum(fieldNames), op: z.enum(Object.keys(OPERATORS) as [Operator, ...Operator[]]), value: z.union([z.number().finite(), z.boolean()]), value2: z.number().finite().optional() }).strict()
  .refine((rule) => FILTER_FIELDS[rule.field].kind === "boolean" ? rule.op === "eq" && typeof rule.value === "boolean" : typeof rule.value === "number", { message: "Trường đúng/sai chỉ dùng phép '=' với giá trị đúng/sai; trường số cần giá trị số." })
  .refine((rule) => rule.op !== "between" || (typeof rule.value2 === "number" && typeof rule.value === "number" && rule.value2 >= rule.value), { message: "'Trong khoảng' cần hai giá trị, giá trị sau ≥ giá trị trước." });
// Nesting is capped so a stored preset can never be pathological to evaluate.
const groupSchema = (depth: number): z.ZodType<FilterGroup> => z.object({ match: z.enum(["all", "any"]), rules: z.array(depth > 0 ? z.union([ruleSchema, z.lazy(() => groupSchema(depth - 1))]) : ruleSchema).min(1).max(20) }).strict() as z.ZodType<FilterGroup>;
export const filterGroupSchema = groupSchema(2);

// A metric can be a lower bound (e.g. fees summed until a page cap): "≥ x" may pass early, "< x" stays unknown.
export type MetricValue = number | boolean | { lowerBound: number } | null | undefined;
export type Metrics = Partial<Record<FilterField, MetricValue>>;
export type Outcome = "pass" | "fail" | "unknown";
export type RuleResult = { field: FilterField; op: Operator; value: number | boolean; value2?: number; actual: MetricValue; outcome: Outcome };

export function evaluateRule(rule: FilterRule, metrics: Metrics): RuleResult {
  const actual = metrics[rule.field];
  const done = (outcome: Outcome): RuleResult => ({ ...rule, actual, outcome });
  if (actual === null || actual === undefined) return done("unknown");
  if (typeof actual === "boolean") return done(rule.op === "eq" && actual === rule.value ? "pass" : "fail");
  const target = rule.value as number;
  if (typeof actual === "object") {
    const floor = actual.lowerBound;
    if ((rule.op === "gt" && floor > target) || (rule.op === "gte" && floor >= target)) return done("pass");
    if ((rule.op === "lt" && floor >= target) || (rule.op === "lte" && floor > target) || (rule.op === "between" && floor > (rule.value2 ?? Infinity))) return done("fail");
    return done("unknown");
  }
  const ok = rule.op === "gt" ? actual > target : rule.op === "gte" ? actual >= target : rule.op === "lt" ? actual < target : rule.op === "lte" ? actual <= target : rule.op === "eq" ? actual === target : actual >= target && actual <= (rule.value2 ?? target);
  return done(ok ? "pass" : "fail");
}

const isGroup = (item: FilterRule | FilterGroup): item is FilterGroup => "match" in item;

// Three-valued logic: AND fails on any fail, OR passes on any pass; otherwise unknown data keeps the result unknown.
export function evaluateGroup(group: FilterGroup, metrics: Metrics): { outcome: Outcome; results: RuleResult[] } {
  const results: RuleResult[] = [], outcomes: Outcome[] = [];
  for (const item of group.rules) {
    if (isGroup(item)) { const nested = evaluateGroup(item, metrics); results.push(...nested.results); outcomes.push(nested.outcome); }
    else { const result = evaluateRule(item, metrics); results.push(result); outcomes.push(result.outcome); }
  }
  const outcome: Outcome = group.match === "all"
    ? outcomes.includes("fail") ? "fail" : outcomes.includes("unknown") ? "unknown" : "pass"
    : outcomes.includes("pass") ? "pass" : outcomes.includes("unknown") ? "unknown" : "fail";
  return { outcome, results };
}

export function fieldsUsed(group: FilterGroup): Set<FilterField> {
  const fields = new Set<FilterField>();
  for (const item of group.rules) (isGroup(item) ? fieldsUsed(item) : new Set([item.field])).forEach((field) => fields.add(field));
  return fields;
}

// Largest "fees ≥ x" target in a preset: fee scanning can stop once this is reached.
export function feeStopTarget(group: FilterGroup): number | null {
  let best: number | null = null;
  for (const item of group.rules) {
    const candidate = isGroup(item) ? feeStopTarget(item) : item.field === "totalFeesSol" && typeof item.value === "number" ? Math.max(item.value, item.value2 ?? item.value) : null;
    if (candidate !== null) best = best === null ? candidate : Math.max(best, candidate);
  }
  return best;
}

export function describeRule(rule: FilterRule) {
  const field = FILTER_FIELDS[rule.field];
  if (field.kind === "boolean") return `${field.label}: ${rule.value ? "có" : "không"}`;
  return rule.op === "between" ? `${field.label} ${rule.value}–${rule.value2}` : `${field.label} ${OPERATORS[rule.op]} ${rule.value}`;
}

// The user's prefilter, seeded as the default preset.
export const DEFAULT_PRESET: { name: string; rules: FilterGroup } = {
  name: "Lọc sơ bộ",
  rules: { match: "all", rules: [
    { field: "top10Pct", op: "lt", value: 30 },
    { field: "bundlePct", op: "lt", value: 15 },
    { field: "volume24hUsd", op: "gte", value: 20_000 },
    { field: "totalFeesSol", op: "gt", value: 10 },
  ] },
};
