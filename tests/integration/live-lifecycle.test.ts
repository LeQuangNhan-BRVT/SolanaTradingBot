import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";
config({ path: ".env.local" });
import { getDatabase } from "../../src/db/client";
import { confirmLiveEntry, confirmLiveExit, getLiveSpentTodayLamports, getTradingControls, markLiveOrderPrepared, releaseOrphanClosingPositions, reserveLiveEntry, reserveLiveExit, updateTradingControls } from "../../src/db/repository";
import { auditLogs, fills, orders, positions, riskAssessments, signals, tokens } from "../../src/db/schema";
import { recoverLiveOrders, type RecoveryChain } from "../../src/lib/live-recovery";
import { assertLiveSendAllowed } from "../../src/lib/shadow";
import type { LiveSwapExecution } from "../../src/lib/live";
import type { JupiterQuote } from "../../src/lib/shadow";

const WSOL = "So11111111111111111111111111111111111111112";
const INCLUDE_ALL = -60_000; // recovery treats every pending order as old enough

async function createEligibleToken() {
  const db = getDatabase(), mint = `test-live-${randomUUID()}`;
  const [token] = await db.insert(tokens).values({ mint, symbol: "TLIVE", name: "Live lifecycle test", status: "eligible", decimals: 6 }).returning({ id: tokens.id });
  const [risk] = await db.insert(riskAssessments).values({ tokenId: token.id, version: 1, status: "eligible", score: 0, checks: [] }).returning({ id: riskAssessments.id });
  return { mint, tokenId: token.id, riskId: risk.id };
}

async function cleanup(tokenId: string) {
  const db = getDatabase();
  const orderIds = (await db.select({ id: orders.id }).from(orders).where(eq(orders.tokenId, tokenId))).map((row) => row.id);
  const positionIds = (await db.select({ id: positions.id }).from(positions).where(eq(positions.tokenId, tokenId))).map((row) => row.id);
  if (orderIds.length) { await db.delete(fills).where(inArray(fills.orderId, orderIds)); await db.delete(auditLogs).where(inArray(auditLogs.entityId, orderIds)); await db.delete(orders).where(inArray(orders.id, orderIds)); }
  if (positionIds.length) await db.delete(positions).where(inArray(positions.id, positionIds));
  await db.delete(signals).where(eq(signals.tokenId, tokenId));
  await db.delete(riskAssessments).where(eq(riskAssessments.tokenId, tokenId));
  await db.delete(tokens).where(eq(tokens.id, tokenId));
}

const quote = (mint: string, inAmount: string, outAmount: string, buy = true): JupiterQuote => ({ inputMint: buy ? WSOL : mint, outputMint: buy ? mint : WSOL, inAmount, outAmount });
const decision = { accepted: true, score: 80, reasons: [], metrics: {} };
const execution = (mint: string, signature: string, tokenAmountRaw: string, lamports: string): LiveSwapExecution => ({ signature, wallet: "TestWallet1111111111111111111111111111111111", slot: 1, blockTime: new Date(), tokenMint: mint, tokenAmountRaw, lamports, feeLamports: "15000", prioritizationFeeLamports: null, computeUnitLimit: null });

function mockChain(states: Record<string, { status: Awaited<ReturnType<RecoveryChain["getSignatureStatus"]>>; execution?: LiveSwapExecution }>, blockHeight = 1_000): RecoveryChain {
  return { getSignatureStatus: async (signature) => states[signature]?.status ?? null, getBlockHeight: async () => blockHeight, fetchExecution: async (signature) => states[signature]?.execution ?? null };
}

test("crashed buy is confirmed exactly once by recovery with real cost and a fill", async () => {
  const { mint, tokenId, riskId } = await createEligibleToken();
  try {
    const reserved = await reserveLiveEntry(mint, riskId, quote(mint, "50000000", "1000"), decision);
    assert.ok(reserved?.orderId);
    const signature = `test-sig-${randomUUID()}`;
    await markLiveOrderPrepared(reserved.orderId, { signature, wallet: "TestWallet1111111111111111111111111111111111", lastValidBlockHeight: 2_000n });
    // Worker "crashes" here: the transaction landed but the live path never confirmed it.
    const landed = execution(mint, signature, "990", "52040000");
    const results = await recoverLiveOrders(mockChain({ [signature]: { status: { err: null, confirmationStatus: "confirmed" }, execution: landed } }), INCLUDE_ALL);
    assert.equal(results.find((item) => item.orderId === reserved.orderId)?.action, "confirmed");
    const [position] = await getDatabase().select().from(positions).where(eq(positions.tokenId, tokenId));
    assert.equal(position.costLamports, "52040000");
    assert.equal(position.quantityRaw, "990");
    assert.equal((await getDatabase().select().from(fills).where(eq(fills.orderId, reserved.orderId))).length, 1);
    // The live path finishing late must not open a second position.
    assert.equal((await confirmLiveEntry(reserved.orderId, landed))?.duplicate, true);
    assert.equal((await getDatabase().select().from(positions).where(eq(positions.tokenId, tokenId))).length, 1);
    assert.ok(await getLiveSpentTodayLamports() >= 52_040_000n);
  } finally { await cleanup(tokenId); }
});

test("expired sell is failed, position reopens and a retry can exit with realized PnL", async () => {
  const { mint, tokenId } = await createEligibleToken();
  try {
    const db = getDatabase();
    const [position] = await db.insert(positions).values({ tokenId, mode: "live", status: "open", quantityRaw: "1000", costLamports: "50000000" }).returning({ id: positions.id });
    const first = await reserveLiveExit(position.id, mint, quote(mint, "1000", "70000000", false), "take_profit", 4000);
    assert.ok(first?.orderId);
    assert.equal((await reserveLiveExit(position.id, mint, quote(mint, "1000", "70000000", false), "take_profit", 4000))?.duplicate, true);
    const lost = `test-sig-${randomUUID()}`;
    await markLiveOrderPrepared(first.orderId, { signature: lost, wallet: "TestWallet1111111111111111111111111111111111", lastValidBlockHeight: 500n });
    const results = await recoverLiveOrders(mockChain({}, 501), INCLUDE_ALL);
    assert.equal(results.find((item) => item.orderId === first.orderId)?.action, "failed");
    assert.equal((await db.select().from(positions).where(eq(positions.id, position.id)))[0].status, "open");

    const retry = await reserveLiveExit(position.id, mint, quote(mint, "1000", "69000000", false), "take_profit", 3800);
    assert.ok(retry?.orderId && retry.orderId !== first.orderId);
    const sold = execution(mint, `test-sig-${randomUUID()}`, "1000", "68500000");
    const saved = await confirmLiveExit(retry.orderId, sold);
    assert.equal(saved?.realizedPnlLamports, "18500000");
    assert.equal((await db.select().from(positions).where(eq(positions.id, position.id)))[0].status, "closed");
  } finally { await cleanup(tokenId); }
});

test("recovery waits for an unexpired transaction and fails an unsigned abandoned reservation", async () => {
  const { mint, tokenId, riskId } = await createEligibleToken();
  try {
    const reserved = await reserveLiveEntry(mint, riskId, quote(mint, "50000000", "1000"), decision);
    assert.ok(reserved?.orderId);
    const signature = `test-sig-${randomUUID()}`;
    await markLiveOrderPrepared(reserved.orderId, { signature, wallet: "TestWallet1111111111111111111111111111111111", lastValidBlockHeight: 5_000n });
    assert.equal((await recoverLiveOrders(mockChain({}, 4_000), INCLUDE_ALL)).find((item) => item.orderId === reserved.orderId)?.action, "wait");
    await getDatabase().update(orders).set({ status: "quoted", signature: null }).where(eq(orders.id, reserved.orderId));
    assert.equal((await recoverLiveOrders(mockChain({}, 4_000), INCLUDE_ALL)).find((item) => item.orderId === reserved.orderId)?.action, "failed");
  } finally { await cleanup(tokenId); }
});

test("orphaned closing position is released back to open", async () => {
  const { tokenId } = await createEligibleToken();
  try {
    const [position] = await getDatabase().insert(positions).values({ tokenId, mode: "live", status: "closing", quantityRaw: "1", costLamports: "1" }).returning({ id: positions.id });
    assert.ok((await releaseOrphanClosingPositions()).includes(position.id));
    assert.equal((await getDatabase().select().from(positions).where(eq(positions.id, position.id)))[0].status, "open");
  } finally { await cleanup(tokenId); }
});

test("halt blocks every live send while pause blocks only entries", async () => {
  const initial = await getTradingControls();
  try {
    await updateTradingControls(true, "integration pause", false);
    await assert.rejects(assertLiveSendAllowed("buy"));
    await assertLiveSendAllowed("sell");
    await updateTradingControls(false, "integration halt", true);
    const halted = await getTradingControls();
    assert.equal(halted.haltAll, true);
    assert.equal(halted.entriesPaused, true);
    await assert.rejects(assertLiveSendAllowed("sell"));
  } finally { await updateTradingControls(initial.entriesPaused, initial.reason ?? "restored after integration test", initial.haltAll); }
});
