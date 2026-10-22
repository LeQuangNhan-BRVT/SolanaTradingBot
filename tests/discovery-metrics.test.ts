import test from "node:test";
import assert from "node:assert/strict";
import { feesFromRecords, historyCredits, launchBundleFromRecords, marketFromPairs, top10FromHolders, type HistoryRecord } from "../src/lib/discovery-metrics";

const MINT = "M", CURVE = "curve", POOL = "pool";
const buy = (slot: number, owner: string, amount: string, fee = 5_000, extra: unknown[] = []): HistoryRecord => ({ slot, blockTime: slot, meta: { fee, preTokenBalances: [], postTokenBalances: [{ mint: MINT, owner, accountIndex: 1, uiTokenAmount: { amount } }] }, transaction: { message: { instructions: extra } } });

test("top 10 excludes the pool vault and bonding curve", () => {
  const holders = [{ owner: POOL, amountRaw: "800" }, { owner: CURVE, amountRaw: "50" }, ...Array.from({ length: 12 }, (_, index) => ({ owner: `w${index}`, amountRaw: "10" }))];
  assert.equal(top10FromHolders(holders, "1000", new Set([POOL, CURVE])), 10);
});

test("launch bundle counts creation-slot buys and multi-wallet early slots only", () => {
  const records = [buy(100, CURVE, "1000"), buy(100, "dev", "50"), buy(100, "sniper", "30"), buy(101, "a", "10"), buy(101, "b", "10"), buy(102, "solo", "40"), buy(110, "late1", "5"), buy(110, "late2", "5")];
  const result = launchBundleFromRecords(records, MINT, "1000", new Set([CURVE, POOL]));
  // dev 50 + sniper 30 (creation slot) + a 10 + b 10 (two buyers in slot 101) = 100 of 1000.
  assert.deepEqual(result, { bundlePct: 10, wallets: 4 });
});

test("fees include network fee and Jito tips", () => {
  const tip = { parsed: { type: "transfer", info: { destination: "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", lamports: 1_000_000 } } };
  const other = { parsed: { type: "transfer", info: { destination: "someone", lamports: 9_000_000 } } };
  assert.equal(feesFromRecords([buy(1, "a", "1", 5_000, [tip]), buy(2, "b", "1", 10_000, [other])]), 1_015_000);
  assert.equal(historyCredits(0), 10);
  assert.equal(historyCredits(250), 30);
});

test("market prefers the post-migration PumpSwap pair", () => {
  const pair = (dexId: string, liquidity: number, volume: number) => ({ dexId, pairAddress: dexId, baseToken: { address: MINT, symbol: "TK", name: "Token" }, liquidity: { usd: liquidity }, volume: { h24: volume }, txns: { h24: { buys: 30, sells: 10 } }, marketCap: 1e6 });
  const market = marketFromPairs([pair("raydium", 90_000, 1), pair("pumpswap", 40_000, 25_000)], MINT);
  assert.equal(market?.dexId, "pumpswap");
  assert.equal(market?.volume24hUsd, 25_000);
  assert.equal(market?.buySellRatio24h, 3);
  assert.equal(marketFromPairs([], MINT), null);
});
