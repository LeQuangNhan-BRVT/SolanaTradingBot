import { PublicKey } from "@solana/web3.js";
import { deleteDiscoveredToken, ensureDefaultPreset, updateWatchlist, WatchlistError, expireDiscoveredTokens, getDiscoverySettings, getRuntimeValue, insertDiscoveredTokens, listDiscoveredForRecheck, listFilterPresets, setRuntimeValue, setTokenTags, updateDiscoveredToken, type DiscoveredToken } from "@/db/repository";
import { adjustHeliusCredits, reserveHeliusCredits, unscheduleTokenJobs } from "@/queue/client";
import { assessAndSaveCandidate } from "./candidate-assessment";
import { fetchDexFlags, fetchLaunchBundle, fetchMarkets, fetchTop10Pct, fetchTotalFees, rpcConnection, type MarketMetrics } from "./discovery-metrics";
import { DEFAULT_PRESET, evaluateGroup, feeStopTarget, fieldsUsed, filterGroupSchema, type FilterField, type FilterGroup, type Metrics, type Outcome, type RuleResult } from "./filter-rules";
import { decodeMigrateInstruction } from "./migration";
import { MAX_SUPPORTED_TX_VERSION } from "./solana";
import { sendAlertOnce } from "./alerts";

// Every Pump.fun -> PumpSwap migration is executed by this account.
export const MIGRATION_ACCOUNT = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function pollMigrations() {
  const rpc = rpcConnection(), cursor = (await getRuntimeValue<{ signature?: string }>("discovery-cursor"))?.signature;
  // First run starts near "now" instead of backfilling the account's whole history.
  const signatures = await rpc.getSignaturesForAddress(new PublicKey(MIGRATION_ACCOUNT), cursor ? { until: cursor, limit: 200 } : { limit: 10 }, "confirmed");
  const rows = new Map<string, { mint: string; poolAddress: string; migrationSignature: string; slot: bigint; migratedAt: Date }>();
  // Oldest first and sequential with a short pause: the free Helius tier rejects bursts with 429.
  for (const item of [...signatures].reverse()) {
    if (item.err !== null) continue;
    const tx = await rpc.getParsedTransaction(item.signature, { maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION, commitment: "confirmed" }).catch(() => null);
    await sleep(120);
    if (!tx || tx.meta?.err) continue;
    for (const instruction of [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions?.flatMap((group) => group.instructions) ?? [])]) {
      const decoded = decodeMigrateInstruction(instruction);
      if (decoded && !rows.has(decoded.mint)) rows.set(decoded.mint, { mint: decoded.mint, poolAddress: decoded.pool, migrationSignature: item.signature, slot: BigInt(tx.slot), migratedAt: new Date((tx.blockTime ?? item.blockTime ?? Math.floor(Date.now() / 1000)) * 1000) });
    }
  }
  const inserted = await insertDiscoveredTokens([...rows.values()]);
  if (signatures[0]) await setRuntimeValue("discovery-cursor", { signature: signatures[0].signature, polledAt: new Date().toISOString() });
  return { signatures: signatures.length, migrations: rows.size, inserted, truncated: cursor !== undefined && signatures.length === 200 };
}

export type DiscoveryProviders = {
  markets(mints: string[]): Promise<Map<string, MarketMetrics>>;
  flags(mint: string): Promise<{ dexPaid: boolean; cto: boolean }>;
  top10(mint: string, pool: string): Promise<{ top10Pct: number | null; supplyRaw: string }>;
  bundle(mint: string, supplyRaw: string, pool: string): Promise<{ result: { bundlePct: number; wallets: number } | null; credits: number }>;
  fees(mint: string, stopAtSol: number, maxPages: number): Promise<{ totalFeesSol: number | { lowerBound: number }; credits: number; pages: number; complete: boolean }>;
  reserveCredits(credits: number): Promise<boolean>;
  adjustCredits(delta: number): Promise<void>;
};

export const liveProviders = (dailyBudget: number): DiscoveryProviders => ({
  markets: fetchMarkets, flags: fetchDexFlags, top10: fetchTop10Pct, bundle: fetchLaunchBundle, fees: fetchTotalFees,
  reserveCredits: (credits) => reserveHeliusCredits(credits, dailyBudget), adjustCredits: adjustHeliusCredits,
});

export type Preset = { id: string; name: string; rules: FilterGroup; autoPromote: boolean };
export type PresetEvaluation = { presetId: string; name: string; outcome: Outcome; results: RuleResult[] };
type StoredMetrics = Metrics & { supplyRaw?: string; priceUsd?: string | null; pairAddress?: string; dexId?: string; bundleWallets?: number; feesPages?: number };

// Per-cycle caps keep a burst of migrations from exhausting RPC, DexScreener or Helius limits in one go.
export type CycleBudget = { top10: number; bundle: number; fees: number; flags: number };
const FEE_PAGE_CAP = 5;
const minutesSince = (date: Date | null) => date ? (Date.now() - date.getTime()) / 60_000 : Infinity;

const evaluateAll = (presets: Preset[], metrics: Metrics): PresetEvaluation[] => presets.map((preset) => ({ presetId: preset.id, name: preset.name, ...evaluateGroup(preset.rules, metrics) }));
const needs = (presets: Preset[], evaluations: PresetEvaluation[], field: FilterField) => evaluations.some((evaluation, index) => evaluation.outcome === "unknown" && fieldsUsed(presets[index].rules).has(field));

// Staged evaluation, cheap to expensive: a check only runs when some preset still depends on it to reach a verdict.
export async function evaluateDiscovered(token: DiscoveredToken, presets: Preset[], providers: DiscoveryProviders, budget: CycleBudget) {
  const metrics: StoredMetrics = { ...(token.metrics as StoredMetrics), ageMinutes: Math.round(minutesSince(token.migratedAt)) };
  const patch: Partial<DiscoveredToken> = {};
  let evaluations = evaluateAll(presets, metrics);
  // Stages run strictly in order: when a cheaper metric a preset needs is still missing (cap or budget reached),
  // costlier stages wait for a later cycle instead of spending on a token the cheaper check might reject.
  let blocked = false;

  if (needs(presets, evaluations, "top10Pct") && minutesSince(token.top10CheckedAt) > 30 && budget.top10 > 0) {
    budget.top10--;
    const top10 = await providers.top10(token.mint, token.poolAddress);
    metrics.top10Pct = top10.top10Pct; metrics.supplyRaw = top10.supplyRaw; patch.top10CheckedAt = new Date();
    evaluations = evaluateAll(presets, metrics);
  }
  if (needs(presets, evaluations, "top10Pct") && (metrics.top10Pct === undefined || metrics.top10Pct === null)) blocked = true;
  // Launch bundles never change, so they are measured once.
  if (!blocked && needs(presets, evaluations, "bundlePct") && !token.bundleCheckedAt && metrics.supplyRaw && budget.bundle > 0 && await providers.reserveCredits(20)) {
    budget.bundle--;
    const bundle = await providers.bundle(token.mint, metrics.supplyRaw, token.poolAddress);
    await providers.adjustCredits(bundle.credits - 20);
    metrics.bundlePct = bundle.result?.bundlePct ?? null; metrics.bundleWallets = bundle.result?.wallets; patch.bundleCheckedAt = new Date();
    evaluations = evaluateAll(presets, metrics);
  }
  // Fees only grow: once a lower bound clears the target it stays cleared; otherwise re-measure at most hourly.
  if (needs(presets, evaluations, "bundlePct") && (metrics.bundlePct === undefined || metrics.bundlePct === null)) blocked = true;
  const stopAt = Math.max(0, ...presets.map((preset) => feeStopTarget(preset.rules) ?? 0));
  if (!blocked && needs(presets, evaluations, "totalFeesSol") && minutesSince(token.feesCheckedAt) > 60 && budget.fees > 0 && await providers.reserveCredits(FEE_PAGE_CAP * 100)) {
    budget.fees--;
    const fees = await providers.fees(token.mint, stopAt, FEE_PAGE_CAP);
    await providers.adjustCredits(fees.credits - FEE_PAGE_CAP * 100);
    metrics.totalFeesSol = fees.totalFeesSol; metrics.feesPages = fees.pages; patch.feesCheckedAt = new Date();
    evaluations = evaluateAll(presets, metrics);
  }
  // Display flags: fetched only for tokens still in contention.
  if (evaluations.some((evaluation) => evaluation.outcome !== "fail") && minutesSince(token.flagsCheckedAt) > 60 && budget.flags > 0) {
    budget.flags--;
    const flags = await providers.flags(token.mint).catch(() => null);
    if (flags) { metrics.dexPaid = flags.dexPaid; metrics.cto = flags.cto; patch.flagsCheckedAt = new Date(); evaluations = evaluateAll(presets, metrics); }
  }
  const matched = presets.find((preset, index) => preset.autoPromote && evaluations[index].outcome === "pass") ?? null;
  return { metrics, evaluations, matched, patch };
}

const presetTag = (name: string) => `loc-${name}`;
export const NO_LONGER_MATCHING_TAG = "khong-con-dat";

export async function promoteDiscovered(token: DiscoveredToken, presetName: string | null) {
  await assessAndSaveCandidate(token.mint, { migration: { signature: token.migrationSignature, slot: token.slot, blockTime: token.migratedAt, poolAddress: token.poolAddress, verified: true } });
  await setTokenTags(token.mint, (tags) => [...tags, "auto-migrated", ...(presetName ? [presetTag(presetName)] : ["thu-cong"])]);
}

// Promoted tokens that stop matching are archived (reversible); a token with an open position is kept and only tagged.
async function archiveNoLongerMatching(mint: string) {
  await setTokenTags(mint, (tags) => [...tags, NO_LONGER_MATCHING_TAG]);
  try { await updateWatchlist(mint, { archived: true }); }
  catch (error) { if (error instanceof WatchlistError && error.status === 409) return false; throw error; }
  await unscheduleTokenJobs(mint).catch((error) => console.error("Unable to unschedule archived token", error));
  return true;
}

export function parsePresets(rows: Awaited<ReturnType<typeof listFilterPresets>>): Preset[] {
  return rows.filter((row) => row.enabled).flatMap((row) => { const parsed = filterGroupSchema.safeParse(row.rules); return parsed.success ? [{ id: row.id, name: row.name, rules: parsed.data, autoPromote: row.autoPromote }] : []; });
}

export async function runDiscoveryCycle(options: { providers?: DiscoveryProviders; poll?: boolean; budget?: CycleBudget; batchSize?: number } = {}) {
  const settings = await getDiscoverySettings();
  if (!settings.enabled && !options.providers) return { skipped: true, reason: "Discovery is disabled." };
  const providers = options.providers ?? liveProviders(settings.heliusDailyCredits);
  await ensureDefaultPreset({ name: DEFAULT_PRESET.name, rules: DEFAULT_PRESET.rules as unknown as Record<string, unknown> });
  const poll = options.poll === false ? null : await pollMigrations().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  const expired = await expireDiscoveredTokens(settings.retentionHours);
  const presets = parsePresets(await listFilterPresets());
  const batch = await listDiscoveredForRecheck(settings.recheckMinutes, options.batchSize ?? 90);
  const markets = batch.length ? await providers.markets(batch.map((token) => token.mint)).catch(() => new Map<string, MarketMetrics>()) : new Map<string, MarketMetrics>();
  const budget: CycleBudget = options.budget ?? { top10: 15, bundle: 5, fees: 3, flags: 10 };
  const summary = { checked: 0, promoted: 0, removed: 0, noLongerMatching: 0, archived: 0, errors: 0 };

  for (const token of batch) {
    const market = markets.get(token.mint);
    const base: StoredMetrics = { ...(token.metrics as StoredMetrics) };
    if (market) Object.assign(base, { volume24hUsd: market.volume24hUsd, liquidityUsd: market.liquidityUsd, mcapUsd: market.mcapUsd, priceUsd: market.priceUsd, priceChange1h: market.priceChange1h, priceChange24h: market.priceChange24h, buys24h: market.buys24h, sells24h: market.sells24h, buySellRatio24h: market.buySellRatio24h, boosts: market.boosts, hasSocials: market.hasSocials, pairAddress: market.pairAddress, dexId: market.dexId });
    const current = { ...token, metrics: base as Record<string, unknown> };
    try {
      const result = await evaluateDiscovered(current, presets, providers, budget);
      summary.checked++;
      const patch: Partial<DiscoveredToken> = { ...result.patch, metrics: result.metrics as Record<string, unknown>, evaluation: result.evaluations as unknown as Array<Record<string, unknown>>, marketCheckedAt: new Date(), lastError: null, ...(market ? { symbol: market.symbol, name: market.name } : {}) };
      if (token.status === "pending" && result.matched) {
        await promoteDiscovered(current, result.matched.name);
        Object.assign(patch, { status: "promoted", matchedPresetId: result.matched.id, promotedAt: new Date() });
        summary.promoted++;
        void sendAlertOnce(`discovery-promoted:${token.mint}`, 24 * 60 * 60_000, { type: "discovery.promoted", severity: "info", title: `Khám phá: ${market?.symbol ?? token.mint.slice(0, 6)} vào watchlist`, message: `Đạt preset "${result.matched.name}".`, data: { mint: token.mint, presetId: result.matched.id } });
      } else if (token.status === "pending" && presets.length > 0 && result.evaluations.every((evaluation) => evaluation.outcome === "fail")) {
        // A token that fails every enabled preset leaves the inbox at once; tokens with any "unknown" verdict stay to be re-checked.
        await deleteDiscoveredToken(token.id);
        summary.removed++;
        continue;
      } else if (token.status === "promoted") {
        const own = result.evaluations.find((evaluation) => evaluation.presetId === token.matchedPresetId);
        if (own?.outcome === "fail") {
          summary.noLongerMatching++;
          const archived = await archiveNoLongerMatching(token.mint);
          if (archived) { patch.status = "archived"; summary.archived++; }
          const reasons = own.results.filter((item) => item.outcome === "fail").map((item) => item.field).join(", ");
          void sendAlertOnce(`discovery-unmatched:${token.mint}`, 24 * 60 * 60_000, { type: "discovery.unmatched", severity: "warning", title: `${market?.symbol ?? token.mint.slice(0, 6)} không còn đạt "${own.name}"`, message: archived ? `Đã tự lưu trữ khỏi watchlist (${reasons}).` : `Giữ lại vì đang có vị thế mở (${reasons}).`, data: { mint: token.mint, archived } });
        } else if (own?.outcome === "pass") await setTokenTags(token.mint, (tags) => tags.filter((tag) => tag !== NO_LONGER_MATCHING_TAG));
      }
      await updateDiscoveredToken(token.id, patch);
    } catch (error) {
      summary.errors++;
      await updateDiscoveredToken(token.id, { lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300), marketCheckedAt: new Date() });
    }
  }
  return { skipped: false, poll, expired, presets: presets.length, batch: batch.length, ...summary };
}
