import test from "node:test";
import assert from "node:assert/strict";
import { assessLiveEntryLimits, decideRecovery, estimatePositionPnlBps, executionFromChange, reconcileHoldings, shouldCheckExit } from "../src/lib/live-safety";
import type { WalletChange } from "../src/lib/wallet-tracker";

const limits = { maxEntryLamports: 100_000_000n, dailySpendLimitLamports: 300_000_000n, minSolReserveLamports: 50_000_000n };

test("live limits accept an entry within every cap", () => {
  assert.equal(assessLiveEntryLimits({ entryLamports: 50_000_000n, spentTodayLamports: 0n, walletLamports: 1_000_000_000n }, limits).accepted, true);
});

test("live limits reject oversize, daily overspend, low reserve and unknown balance", () => {
  assert.equal(assessLiveEntryLimits({ entryLamports: 150_000_000n, spentTodayLamports: 0n, walletLamports: 1_000_000_000n }, limits).accepted, false);
  assert.equal(assessLiveEntryLimits({ entryLamports: 50_000_000n, spentTodayLamports: 260_000_000n, walletLamports: 1_000_000_000n }, limits).accepted, false);
  assert.equal(assessLiveEntryLimits({ entryLamports: 50_000_000n, spentTodayLamports: 0n, walletLamports: 100_000_000n }, limits).accepted, false);
  assert.equal(assessLiveEntryLimits({ entryLamports: 50_000_000n, spentTodayLamports: 0n, walletLamports: null }, limits).accepted, false);
});

test("recovery fails orders that were never broadcast", () => {
  assert.equal(decideRecovery({ signature: null, status: null, blockHeight: 100, lastValidBlockHeight: null }), "fail");
});

test("recovery confirms landed transactions and fails on-chain errors", () => {
  assert.equal(decideRecovery({ signature: "s", status: { err: null, confirmationStatus: "confirmed" }, blockHeight: 100, lastValidBlockHeight: 200n }), "confirm");
  assert.equal(decideRecovery({ signature: "s", status: { err: null, confirmationStatus: "finalized" }, blockHeight: 999, lastValidBlockHeight: 200n }), "confirm");
  assert.equal(decideRecovery({ signature: "s", status: { err: { InstructionError: [0, "x"] }, confirmationStatus: "confirmed" }, blockHeight: 100, lastValidBlockHeight: 200n }), "fail");
});

test("recovery waits until the blockhash has expired before failing an unseen transaction", () => {
  assert.equal(decideRecovery({ signature: "s", status: null, blockHeight: 200, lastValidBlockHeight: 200n }), "wait");
  assert.equal(decideRecovery({ signature: "s", status: null, blockHeight: 201, lastValidBlockHeight: 200n }), "fail");
  assert.equal(decideRecovery({ signature: "s", status: null, blockHeight: 999, lastValidBlockHeight: null }), "wait");
  assert.equal(decideRecovery({ signature: "s", status: { err: null, confirmationStatus: "processed" }, blockHeight: 999, lastValidBlockHeight: 200n }), "wait");
});

const change = (solDelta: string, tokenDelta: string, fee = "5000"): WalletChange => ({ signature: "sig", blockTime: null, failed: false, feeLamports: fee, solDeltaLamports: solDelta, tokenChanges: [{ mint: "M", deltaRaw: tokenDelta, decimals: 6 }], kind: "other" });

test("buy execution cost includes network fee", () => {
  assert.deepEqual(executionFromChange(change("-100000000", "500"), "buy", "M"), { tokenAmountRaw: "500", lamports: "100005000", feeLamports: "5000" });
});

test("sell execution proceeds are net of network fee", () => {
  assert.deepEqual(executionFromChange(change("150000000", "-500"), "sell", "M"), { tokenAmountRaw: "500", lamports: "149995000", feeLamports: "5000" });
});

test("execution rejects failed or wrong-direction transactions", () => {
  assert.throws(() => executionFromChange({ ...change("-1", "500"), failed: true }, "buy", "M"));
  assert.throws(() => executionFromChange(change("100", "-500"), "buy", "M"));
  assert.throws(() => executionFromChange(change("100", "500"), "sell", "M"));
});

test("reconciliation flags missing tokens, reports surplus and skips pending mints", () => {
  const result = reconcileHoldings(new Map([["A", 100n], ["B", 50n], ["C", 10n]]), new Map([["A", 90n], ["B", 80n], ["X", 5n]]), new Set(["C"]));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [{ mint: "A", expectedRaw: "100", actualRaw: "90" }]);
  assert.deepEqual(result.surplus, [{ mint: "B", expectedRaw: "50", actualRaw: "80" }]);
});

test("reconciliation passes when the wallet covers every position", () => {
  assert.equal(reconcileHoldings(new Map([["A", 100n]]), new Map([["A", 100n]]), new Set()).ok, true);
});

test("price estimate converts token value to SOL PnL", () => {
  // 1,000 tokens (6 decimals) at $0.02 = $20; SOL $100 -> 0.2 SOL value vs 0.1 SOL cost = +100%.
  assert.equal(estimatePositionPnlBps({ quantityRaw: "1000000000", decimals: 6, costLamports: "100000000", tokenUsd: 0.02, solUsd: 100 }), 10_000);
  assert.equal(estimatePositionPnlBps({ quantityRaw: "1", decimals: 0, costLamports: "0", tokenUsd: 1, solUsd: 100 }), null);
});

test("exit check triggers only near thresholds", () => {
  const settings = { stopLossBps: -1500, takeProfitBps: 3000 };
  assert.equal(shouldCheckExit(-1300, settings), true);
  assert.equal(shouldCheckExit(2800, settings), true);
  assert.equal(shouldCheckExit(500, settings), false);
});

import { isValidSignature, matchManualSwap } from "../src/lib/live-safety";

const walletChange = (signature: string, minutesAgo: number, delta: string, failed = false): WalletChange => ({ signature, blockTime: new Date(Date.now() - minutesAgo * 60_000), failed, feeLamports: "5000", solDeltaLamports: "-1", tokenChanges: [{ mint: "M", deltaRaw: delta, decimals: 6 }], kind: "other" });

test("manual swap match finds the wallet's buy after the order was prepared", () => {
  const since = new Date(Date.now() - 5 * 60_000);
  const changes = [walletChange("old", 30, "100"), walletChange("failed", 1, "100", true), walletChange("sell", 1, "-100"), walletChange("buy", 2, "100")];
  assert.equal(matchManualSwap(changes, "M", "buy", since, new Set()), "buy");
  assert.equal(matchManualSwap(changes, "M", "sell", since, new Set()), "sell");
  assert.equal(matchManualSwap(changes, "M", "buy", since, new Set(["buy"])), null);
  assert.equal(matchManualSwap(changes, "OTHER", "buy", since, new Set()), null);
});

test("signature validation accepts base58 transaction signatures only", () => {
  assert.equal(isValidSignature("5".repeat(88)), true);
  assert.equal(isValidSignature("0OIl".repeat(22)), false);
  assert.equal(isValidSignature("abc"), false);
});
