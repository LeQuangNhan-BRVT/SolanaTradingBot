import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";
config({ path: ".env.local" });
import { getDatabase } from "../../src/db/client";
import { cancelManualOrder, confirmLiveEntry, confirmLiveExit, createManualOrder, createTriggerOrders, getLiveExpectedHoldings, getLivePortfolioState, getLiveSpentTodayLamports, markManualOrderSubmitted } from "../../src/db/repository";
import { auditLogs, fills, orders, positions, tokens, triggerOrders } from "../../src/db/schema";
import { recoverLiveOrders, type RecoveryChain } from "../../src/lib/live-recovery";
import type { LiveSwapExecution } from "../../src/lib/live";
import type { JupiterQuote } from "../../src/lib/shadow";
import type { WalletChange } from "../../src/lib/wallet-tracker";

const WSOL = "So11111111111111111111111111111111111111112";
const WALLET = "UserWallet111111111111111111111111111111111";
const INCLUDE_ALL = -600_000;

async function createToken() {
  const mint = `test-manual-${randomUUID()}`;
  const [token] = await getDatabase().insert(tokens).values({ mint, symbol: "TMAN", name: "Manual test", status: "monitoring", decimals: 6, supplyRaw: "1000000000000000" }).returning({ id: tokens.id });
  return { mint, tokenId: token.id };
}

async function cleanup(tokenId: string) {
  const db = getDatabase();
  const orderIds = (await db.select({ id: orders.id }).from(orders).where(eq(orders.tokenId, tokenId))).map((row) => row.id);
  const triggerIds = (await db.select({ id: triggerOrders.id }).from(triggerOrders).where(eq(triggerOrders.tokenId, tokenId))).map((row) => row.id);
  if (triggerIds.length) { await db.delete(auditLogs).where(inArray(auditLogs.entityId, triggerIds)); await db.delete(triggerOrders).where(inArray(triggerOrders.id, triggerIds)); }
  if (orderIds.length) { await db.delete(fills).where(inArray(fills.orderId, orderIds)); await db.delete(auditLogs).where(inArray(auditLogs.entityId, orderIds)); await db.delete(orders).where(inArray(orders.id, orderIds)); }
  await db.delete(positions).where(eq(positions.tokenId, tokenId));
  await db.delete(tokens).where(eq(tokens.id, tokenId));
}

const quote = (mint: string, buy: boolean, amount: string): JupiterQuote => ({ inputMint: buy ? WSOL : mint, outputMint: buy ? mint : WSOL, inAmount: amount, outAmount: "1" });
const execution = (mint: string, signature: string, tokenAmountRaw: string, lamports: string): LiveSwapExecution => ({ signature, wallet: WALLET, slot: 1, blockTime: new Date(), tokenMint: mint, tokenAmountRaw, lamports, feeLamports: "10000", prioritizationFeeLamports: null, computeUnitLimit: null });
const sig = () => `test${randomUUID().replace(/-/g, "")}`;

test("manual buys average into one wallet position that bot limits and reconciliation ignore", async () => {
  const { mint, tokenId } = await createToken();
  try {
    const spentBefore = await getLiveSpentTodayLamports();
    for (const [tokensOut, lamports] of [["1000", "100000000"], ["500", "60000000"]]) {
      const order = await createManualOrder({ mint, side: "buy", wallet: WALLET, requestedAmountRaw: lamports, quote: quote(mint, true, lamports), lastValidBlockHeight: 10_000n });
      const signature = sig();
      assert.ok(await markManualOrderSubmitted(order.id, signature));
      await confirmLiveEntry(order.id, execution(mint, signature, tokensOut, lamports));
    }
    const rows = await getDatabase().select().from(positions).where(eq(positions.tokenId, tokenId));
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].origin, rows[0].wallet, rows[0].quantityRaw, rows[0].costLamports], ["manual", WALLET, "1500", "160000000"]);
    assert.equal((await getLiveExpectedHoldings()).expected.has(mint), false);
    assert.equal(await getLiveSpentTodayLamports(), spentBefore);
    assert.equal((await getLivePortfolioState(mint)).exposureLamports, (await getLivePortfolioState("none")).exposureLamports);
  } finally { await cleanup(tokenId); }
});

test("manual partial sell resolves a fired wallet alert and cancels its OCO sibling", async () => {
  const { mint, tokenId } = await createToken();
  try {
    const db = getDatabase();
    const [position] = await db.insert(positions).values({ tokenId, mode: "live", status: "open", origin: "manual", wallet: WALLET, quantityRaw: "1000", costLamports: "100000000" }).returning({ id: positions.id });
    const ocoGroup = randomUUID();
    const [tp, sl] = await createTriggerOrders([
      { tokenId, positionId: position.id, mode: "live", type: "take_profit", triggerMcapUsd: "5000000.00", sellPctBps: 4_000, ocoGroup, maxSlippageBps: 300 },
      { tokenId, positionId: position.id, mode: "live", type: "stop_loss", triggerMcapUsd: "500000.00", sellPctBps: 4_000, ocoGroup, maxSlippageBps: 300 },
    ]);
    await db.update(triggerOrders).set({ status: "triggered" }).where(eq(triggerOrders.id, tp.id));
    const order = await createManualOrder({ mint, side: "sell", wallet: WALLET, requestedAmountRaw: "400", quote: quote(mint, false, "400"), lastValidBlockHeight: 10_000n });
    const signature = sig();
    await markManualOrderSubmitted(order.id, signature);
    const saved = await confirmLiveExit(order.id, execution(mint, signature, "400", "70000000"));
    assert.equal(saved?.closed, false);
    assert.equal(saved?.realizedPnlLamports, "30000000");
    const [row] = await db.select().from(positions).where(eq(positions.id, position.id));
    assert.deepEqual([row.status, row.quantityRaw, row.costLamports], ["open", "600", "60000000"]);
    const statuses = Object.fromEntries((await db.select({ id: triggerOrders.id, status: triggerOrders.status }).from(triggerOrders).where(eq(triggerOrders.ocoGroup, ocoGroup))).map((item) => [item.id, item.status]));
    assert.deepEqual([statuses[tp.id], statuses[sl.id]], ["filled", "cancelled"]);
  } finally { await cleanup(tokenId); }
});

test("recovery finds a manual swap the browser never reported, and fails one that never happened", async () => {
  const { mint, tokenId } = await createToken();
  try {
    const db = getDatabase();
    const landed = await createManualOrder({ mint, side: "buy", wallet: WALLET, requestedAmountRaw: "50000000", quote: quote(mint, true, "50000000"), lastValidBlockHeight: 500n });
    const lost = await createManualOrder({ mint, side: "sell", wallet: WALLET, requestedAmountRaw: "10", quote: quote(mint, false, "10"), lastValidBlockHeight: 500n });
    const signature = sig();
    const activity: WalletChange[] = [{ signature, blockTime: new Date(), failed: false, feeLamports: "10000", solDeltaLamports: "-50000000", tokenChanges: [{ mint, deltaRaw: "777", decimals: 6 }], kind: "buy" }];
    const chain: RecoveryChain = { getSignatureStatus: async (value) => value === signature ? { err: null, confirmationStatus: "confirmed" } : null, getBlockHeight: async () => 400, fetchExecution: async (value) => value === signature ? execution(mint, signature, "777", "50010000") : null, walletActivity: async () => activity };
    let results = await recoverLiveOrders(chain, INCLUDE_ALL);
    assert.equal(results.find((item) => item.orderId === landed.id)?.action, "confirmed");
    assert.equal(results.find((item) => item.orderId === lost.id)?.action, "wait");
    assert.equal((await db.select().from(positions).where(eq(positions.tokenId, tokenId)))[0].quantityRaw, "777");
    results = await recoverLiveOrders({ ...chain, getBlockHeight: async () => 501 }, INCLUDE_ALL);
    assert.equal(results.find((item) => item.orderId === lost.id)?.action, "failed");
    // The wallet may still report it late: a failed order without a signature accepts the signature for verification.
    assert.ok(await markManualOrderSubmitted(lost.id, sig()));
  } finally { await cleanup(tokenId); }
});

test("an unsigned manual order can be cancelled; a submitted one cannot", async () => {
  const { mint, tokenId } = await createToken();
  try {
    const first = await createManualOrder({ mint, side: "buy", wallet: WALLET, requestedAmountRaw: "1", quote: quote(mint, true, "1"), lastValidBlockHeight: 1n });
    assert.ok(await cancelManualOrder(first.id));
    const second = await createManualOrder({ mint, side: "buy", wallet: WALLET, requestedAmountRaw: "1", quote: quote(mint, true, "1"), lastValidBlockHeight: 1n });
    await markManualOrderSubmitted(second.id, sig());
    assert.equal(await cancelManualOrder(second.id), null);
    await getDatabase().update(orders).set({ status: "failed" }).where(eq(orders.id, second.id));
  } finally { await cleanup(tokenId); }
});
