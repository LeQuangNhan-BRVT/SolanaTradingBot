import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { eq, inArray, like } from "drizzle-orm";
config({ path: ".env.local" });
import { getDatabase } from "../../src/db/client";
import { expireDiscoveredTokens, insertDiscoveredTokens, saveFilterPreset } from "../../src/db/repository";
import { discoveredTokens, filterPresets, positions, tokens } from "../../src/db/schema";
import { runDiscoveryCycle, type DiscoveryProviders } from "../../src/lib/discovery";
import { closeQueueConnections } from "../../src/queue/client";

after(() => closeQueueConnections());
import type { MarketMetrics } from "../../src/lib/discovery-metrics";

const market = (volume: number): MarketMetrics => ({ symbol: "T", name: "Test", pairAddress: "p", dexId: "pumpswap", volume24hUsd: volume, liquidityUsd: 30_000, mcapUsd: 500_000, priceUsd: "0.0005", priceChange1h: 1, priceChange24h: 2, buys24h: 10, sells24h: 5, buySellRatio24h: 2, boosts: 0, hasSocials: true });

function providers(volumes: Record<string, number>, calls: Record<string, string[]>, credits = { allow: true }): DiscoveryProviders {
  const track = (name: string, mint: string) => { (calls[name] ??= []).push(mint); };
  return {
    markets: async (mints) => new Map(mints.filter((mint) => mint in volumes).map((mint) => [mint, market(volumes[mint])])),
    flags: async (mint) => { track("flags", mint); return { dexPaid: true, cto: false }; },
    top10: async (mint) => { track("top10", mint); return { top10Pct: 50, supplyRaw: "1000000" }; },
    bundle: async (mint) => { track("bundle", mint); return { result: { bundlePct: 5, wallets: 3 }, credits: 20 }; },
    fees: async (mint) => { track("fees", mint); return { totalFeesSol: { lowerBound: 4 }, credits: 50, pages: 5, complete: false }; },
    reserveCredits: async () => credits.allow,
    adjustCredits: async () => undefined,
  };
}

async function seed(prefix: string, count: number, hoursAgo = 0) {
  const rows = Array.from({ length: count }, (_, index) => ({ mint: `${prefix}${index}-${randomUUID().slice(0, 8)}`, poolAddress: `pool-${index}`, migrationSignature: `${prefix}sig-${randomUUID()}`, slot: 1n, migratedAt: new Date(Date.now() - hoursAgo * 3_600_000) }));
  await insertDiscoveredTokens(rows);
  return rows.map((row) => row.mint);
}

async function cleanup(prefix: string, presetIds: string[]) {
  const db = getDatabase();
  await db.delete(discoveredTokens).where(like(discoveredTokens.mint, `${prefix}%`));
  if (presetIds.length) await db.delete(filterPresets).where(inArray(filterPresets.id, presetIds));
}

test("staged evaluation skips expensive checks once a cheap rule decides, and never promotes on unknown", async () => {
  const prefix = `test-disc-${randomUUID().slice(0, 6)}-`, db = getDatabase();
  const preset = await saveFilterPreset({ name: `Test ${prefix}`, rules: { match: "all", rules: [{ field: "volume24hUsd", op: "gte", value: 20_000 }, { field: "top10Pct", op: "lt", value: 60 }, { field: "totalFeesSol", op: "gt", value: 10 }] }, enabled: true, autoPromote: false });
  const [low, high] = await seed(prefix, 2);
  try {
    const calls: Record<string, string[]> = {};
    await runDiscoveryCycle({ providers: providers({ [low]: 5_000, [high]: 30_000 }, calls), poll: false });
    assert.equal(calls.top10?.includes(low) ?? false, false);
    assert.ok(calls.top10?.includes(high));
    assert.ok(calls.fees?.includes(high));
    assert.equal(calls.fees?.includes(low) ?? false, false);
    const [row] = await db.select().from(discoveredTokens).where(eq(discoveredTokens.mint, high));
    const mine = (row.evaluation as Array<{ presetId: string; outcome: string }>).find((item) => item.presetId === preset!.id);
    // Fees are only a lower bound below target: still unknown, so the token stays in the inbox.
    assert.equal(mine?.outcome, "unknown");
    assert.equal(row.status, "pending");
    assert.equal((row.metrics as Record<string, unknown>).dexPaid, true);
    // Failing every enabled preset removes the token from the inbox immediately.
    assert.equal((await db.select().from(discoveredTokens).where(eq(discoveredTokens.mint, low))).length, 0);
  } finally { await cleanup(prefix, preset ? [preset.id] : []); }
});

test("exhausted Helius budget leaves expensive metrics unknown instead of spending", async () => {
  const prefix = `test-disc-${randomUUID().slice(0, 6)}-`;
  const preset = await saveFilterPreset({ name: `Budget ${prefix}`, rules: { match: "all", rules: [{ field: "volume24hUsd", op: "gte", value: 1 }, { field: "bundlePct", op: "lt", value: 15 }] }, enabled: true, autoPromote: false });
  const [mint] = await seed(prefix, 1);
  try {
    const calls: Record<string, string[]> = {};
    await runDiscoveryCycle({ providers: providers({ [mint]: 50_000 }, calls, { allow: false }), poll: false });
    assert.equal(calls.bundle?.includes(mint) ?? false, false);
    assert.equal(calls.fees?.includes(mint) ?? false, false);
  } finally { await cleanup(prefix, preset ? [preset.id] : []); }
});

test("retention only deletes stale pending inbox rows", async () => {
  const prefix = `test-disc-${randomUUID().slice(0, 6)}-`, db = getDatabase();
  const [old] = await seed(prefix, 1, 30), [oldPromoted] = await seed(`${prefix}p`, 1, 30), [fresh] = await seed(`${prefix}f`, 1, 1);
  await db.update(discoveredTokens).set({ status: "promoted" }).where(eq(discoveredTokens.mint, oldPromoted));
  try {
    await expireDiscoveredTokens(24);
    const remaining = (await db.select({ mint: discoveredTokens.mint }).from(discoveredTokens).where(like(discoveredTokens.mint, `${prefix}%`))).map((row) => row.mint);
    assert.equal(remaining.includes(old), false);
    assert.ok(remaining.includes(oldPromoted) && remaining.includes(fresh));
  } finally { await cleanup(prefix, []); }
});

test("promoted tokens that stop matching are archived, unless a position is open", async () => {
  const prefix = `test-disc-${randomUUID().slice(0, 6)}-`, db = getDatabase();
  const preset = await saveFilterPreset({ name: `Archive ${prefix}`, rules: { match: "all", rules: [{ field: "volume24hUsd", op: "gte", value: 20_000 }] }, enabled: true, autoPromote: false });
  const [free, held] = await seed(prefix, 2);
  const tokenIds: string[] = [];
  try {
    for (const mint of [free, held]) {
      const [token] = await db.insert(tokens).values({ mint, symbol: "ARC", name: "Archive test", status: "monitoring", watchTags: ["auto-migrated"] }).returning({ id: tokens.id });
      tokenIds.push(token.id);
      await db.update(discoveredTokens).set({ status: "promoted", promotedAt: new Date(), matchedPresetId: preset!.id }).where(eq(discoveredTokens.mint, mint));
    }
    await db.insert(positions).values({ tokenId: tokenIds[1], mode: "shadow", status: "open", origin: "manual", quantityRaw: "1", costLamports: "1" });
    await runDiscoveryCycle({ providers: providers({ [free]: 1_000, [held]: 1_000 }, {}), poll: false });
    const [freeToken] = await db.select().from(tokens).where(eq(tokens.id, tokenIds[0]));
    const [heldToken] = await db.select().from(tokens).where(eq(tokens.id, tokenIds[1]));
    assert.ok(freeToken.archivedAt);
    assert.equal((await db.select().from(discoveredTokens).where(eq(discoveredTokens.mint, free)))[0].status, "archived");
    assert.equal(heldToken.archivedAt, null);
    assert.ok(heldToken.watchTags.includes("khong-con-dat"));
  } finally {
    if (tokenIds.length) { await db.delete(positions).where(inArray(positions.tokenId, tokenIds)); }
    await cleanup(prefix, preset ? [preset.id] : []);
    if (tokenIds.length) await db.delete(tokens).where(inArray(tokens.id, tokenIds));
  }
});

test("expensive stages wait while a cheaper metric is still missing", async () => {
  const prefix = `test-disc-${randomUUID().slice(0, 6)}-`;
  const preset = await saveFilterPreset({ name: `Order ${prefix}`, rules: { match: "all", rules: [{ field: "volume24hUsd", op: "gte", value: 1 }, { field: "top10Pct", op: "lt", value: 90 }, { field: "bundlePct", op: "lt", value: 15 }, { field: "totalFeesSol", op: "gt", value: 10 }] }, enabled: true, autoPromote: false });
  const [mint] = await seed(prefix, 1);
  try {
    const calls: Record<string, string[]> = {};
    // No top-10 checks left this cycle: neither bundle nor fees may run for this token.
    await runDiscoveryCycle({ providers: providers({ [mint]: 50_000 }, calls), poll: false, budget: { top10: 0, bundle: 5, fees: 3, flags: 10 } });
    assert.equal(calls.bundle?.includes(mint) ?? false, false);
    assert.equal(calls.fees?.includes(mint) ?? false, false);
  } finally { await cleanup(prefix, preset ? [preset.id] : []); }
});
