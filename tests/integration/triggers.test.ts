import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";
config({ path: ".env.local" });
import { getDatabase } from "../../src/db/client";
import { claimTriggerOrder, createTriggerOrders, fillTriggerBuy, fillTriggerSell, listActiveTriggersForPricing, listOpenShadowPositions, sweepTriggerOrders } from "../../src/db/repository";
import { auditLogs, orders, positions, tokens, triggerOrders } from "../../src/db/schema";
import { scanTriggerOrders } from "../../src/lib/trigger-engine";
import type { JupiterQuote } from "../../src/lib/shadow";

const WSOL = "So11111111111111111111111111111111111111112";
// 1B tokens with 6 decimals: mcap in USD = price × 1e9.
const SUPPLY = "1000000000000000";

async function createToken() {
  const mint = `test-trig-${randomUUID()}`;
  const [token] = await getDatabase().insert(tokens).values({ mint, symbol: "TTRIG", name: "Trigger test", status: "monitoring", decimals: 6, supplyRaw: SUPPLY }).returning({ id: tokens.id });
  return { mint, tokenId: token.id };
}

async function cleanup(tokenId: string) {
  const db = getDatabase();
  const triggerIds = (await db.select({ id: triggerOrders.id }).from(triggerOrders).where(eq(triggerOrders.tokenId, tokenId))).map((row) => row.id);
  const orderIds = (await db.select({ id: orders.id }).from(orders).where(eq(orders.tokenId, tokenId))).map((row) => row.id);
  if (triggerIds.length) { await db.delete(auditLogs).where(inArray(auditLogs.entityId, triggerIds)); await db.delete(triggerOrders).where(inArray(triggerOrders.id, triggerIds)); }
  if (orderIds.length) { await db.delete(auditLogs).where(inArray(auditLogs.entityId, orderIds)); await db.delete(orders).where(inArray(orders.id, orderIds)); }
  await db.delete(positions).where(eq(positions.tokenId, tokenId));
  await db.delete(tokens).where(eq(tokens.id, tokenId));
}

const buyQuote = (mint: string, lamports: string, tokensOut: string): JupiterQuote => ({ inputMint: WSOL, outputMint: mint, inAmount: lamports, outAmount: tokensOut, priceImpactPct: "0.001" });
const sellQuote = (mint: string, tokensIn: string, lamports: string): JupiterQuote => ({ inputMint: mint, outputMint: WSOL, inAmount: tokensIn, outAmount: lamports, priceImpactPct: "0.001" });

test("limit buy fills exactly once into a manual position excluded from automated exits", async () => {
  const { mint, tokenId } = await createToken();
  try {
    const [order] = await createTriggerOrders([{ tokenId, mode: "shadow", type: "limit_buy", triggerMcapUsd: "1000000.00", buyLamports: "50000000", maxSlippageBps: 300 }]);
    assert.ok(await claimTriggerOrder(order.id));
    assert.equal(await claimTriggerOrder(order.id), null);
    const filled = await fillTriggerBuy(order.id, buyQuote(mint, "50000000", "5000000000"), 990_000);
    await assert.rejects(fillTriggerBuy(order.id, buyQuote(mint, "50000000", "5000000000"), 990_000));
    const [position] = await getDatabase().select().from(positions).where(eq(positions.id, filled.positionId));
    assert.equal(position.origin, "manual");
    assert.equal(position.costLamports, "50000000");
    assert.equal((await listOpenShadowPositions()).some((item) => item.id === position.id), false);
  } finally { await cleanup(tokenId); }
});

test("bracket: partial take profit keeps position, final stop loss closes it and cancels the OCO sibling", async () => {
  const { mint, tokenId } = await createToken();
  try {
    const db = getDatabase();
    const [position] = await db.insert(positions).values({ tokenId, mode: "shadow", status: "open", origin: "manual", quantityRaw: "1000", costLamports: "100000000" }).returning({ id: positions.id });
    const [partial] = await createTriggerOrders([{ tokenId, positionId: position.id, mode: "shadow", type: "take_profit", triggerMcapUsd: "3000000.00", sellPctBps: 5_000, maxSlippageBps: 300 }]);
    await claimTriggerOrder(partial.id);
    const first = await fillTriggerSell(partial.id, sellQuote(mint, "500", "80000000"), 500n, 3_100_000);
    assert.equal(first.closed, false);
    assert.equal(first.realizedPnlLamports, "30000000");
    let [row] = await db.select().from(positions).where(eq(positions.id, position.id));
    assert.equal(row.quantityRaw, "500");
    assert.equal(row.costLamports, "50000000");

    const ocoGroup = randomUUID();
    const [tp, sl] = await createTriggerOrders([
      { tokenId, positionId: position.id, mode: "shadow", type: "take_profit", triggerMcapUsd: "5000000.00", sellPctBps: 10_000, ocoGroup, maxSlippageBps: 300 },
      { tokenId, positionId: position.id, mode: "shadow", type: "stop_loss", triggerMcapUsd: "500000.00", sellPctBps: 10_000, ocoGroup, maxSlippageBps: 300 },
    ]);
    await claimTriggerOrder(sl.id);
    const last = await fillTriggerSell(sl.id, sellQuote(mint, "500", "20000000"), 500n, 450_000);
    assert.equal(last.closed, true);
    assert.equal(last.realizedPnlLamports, "0");
    [row] = await db.select().from(positions).where(eq(positions.id, position.id));
    assert.equal(row.status, "closed");
    assert.equal((await db.select().from(triggerOrders).where(eq(triggerOrders.id, tp.id)))[0].status, "cancelled");
  } finally { await cleanup(tokenId); }
});

test("sweep expires old orders and cancels sell orders whose position closed", async () => {
  const { tokenId } = await createToken();
  try {
    const db = getDatabase();
    const [position] = await db.insert(positions).values({ tokenId, mode: "shadow", status: "closed", origin: "manual", quantityRaw: "0", costLamports: "0" }).returning({ id: positions.id });
    const [expiring, orphan] = await createTriggerOrders([
      { tokenId, mode: "shadow", type: "limit_buy", triggerMcapUsd: "1000.00", buyLamports: "1000000", maxSlippageBps: 300, expiresAt: new Date(Date.now() - 1_000) },
      { tokenId, positionId: position.id, mode: "shadow", type: "stop_loss", triggerMcapUsd: "1000.00", sellPctBps: 10_000, maxSlippageBps: 300 },
    ]);
    await sweepTriggerOrders();
    const statuses = Object.fromEntries((await db.select({ id: triggerOrders.id, status: triggerOrders.status }).from(triggerOrders).where(eq(triggerOrders.tokenId, tokenId))).map((item) => [item.id, item.status]));
    assert.equal(statuses[expiring.id], "expired");
    assert.equal(statuses[orphan.id], "cancelled");
  } finally { await cleanup(tokenId); }
});

test("price scan fires a crossed limit, ratchets a trailing peak and leaves the rest", async () => {
  const { mint, tokenId } = await createToken();
  try {
    const db = getDatabase();
    const [position] = await db.insert(positions).values({ tokenId, mode: "shadow", status: "open", origin: "manual", quantityRaw: "1000", costLamports: "1" }).returning({ id: positions.id });
    const [limit, far, trailing] = await createTriggerOrders([
      { tokenId, mode: "shadow", type: "limit_buy", triggerMcapUsd: "2000000.00", buyLamports: "1000000", maxSlippageBps: 300 },
      { tokenId, mode: "shadow", type: "limit_buy", triggerMcapUsd: "500000.00", buyLamports: "1000000", maxSlippageBps: 300 },
      { tokenId, positionId: position.id, mode: "shadow", type: "trailing_stop", trailingBps: 2_000, peakMcapUsd: "1000000.00", sellPctBps: 10_000, maxSlippageBps: 300 },
    ]);
    const fired: string[] = [];
    const mine = (await listActiveTriggersForPricing()).filter((item) => item.mint === mint);
    // $0.0015 × 1B = $1.5M: below the $2M limit, above the $500k limit, new trailing peak.
    await scanTriggerOrders(mine, new Map([[mint, 0.0015]]), async (id) => { fired.push(id); });
    assert.deepEqual(fired, [limit.id]);
    const peak = (await db.select().from(triggerOrders).where(eq(triggerOrders.id, trailing.id)))[0].peakMcapUsd;
    assert.equal(Number(peak), 1_500_000);
    fired.length = 0;
    // $1.15M is more than 20% below the $1.5M peak.
    await scanTriggerOrders((await listActiveTriggersForPricing()).filter((item) => item.mint === mint), new Map([[mint, 0.00115]]), async (id) => { fired.push(id); });
    assert.ok(fired.includes(trailing.id) && !fired.includes(far.id));
  } finally { await cleanup(tokenId); }
});
