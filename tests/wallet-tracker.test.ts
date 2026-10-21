import test from "node:test";
import assert from "node:assert/strict";
import { extractWalletChange, formatUnits, parseWalletAddress, summarizeTradedTokens, WalletAddressError, WSOL_MINT } from "../src/lib/wallet-tracker";

const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const balance = (mint: string, amount: string, accountIndex = 1) => ({ accountIndex, mint, owner: OWNER, uiTokenAmount: { amount, decimals: 5, uiAmount: null, uiAmountString: amount } });
const tx = (pre: number, post: number, preTokens: ReturnType<typeof balance>[], postTokens: ReturnType<typeof balance>[], err: unknown = null) => ({
  blockTime: 1_700_000_000,
  transaction: { signatures: ["sig"], message: { accountKeys: [{ pubkey: { toBase58: () => OWNER } }], instructions: [], recentBlockhash: "" } },
  meta: { err, fee: 5_000, preBalances: [pre], postBalances: [post], preTokenBalances: preTokens, postTokenBalances: postTokens, innerInstructions: [], logMessages: [] },
}) as unknown as Parameters<typeof extractWalletChange>[1];

test("formatUnits converts raw amounts without floating point", () => {
  assert.equal(formatUnits("123456789", 9), "0.123456789");
  assert.equal(formatUnits("1000000000", 9), "1");
  assert.equal(formatUnits("-1500", 3), "-1.5");
  assert.equal(formatUnits("42", 0), "42");
});

test("buy: SOL out, token in, fee excluded from trade delta", () => {
  const change = extractWalletChange("sig", tx(1_000_000_000, 899_995_000, [], [balance(MINT, "500")]), OWNER);
  assert.equal(change.kind, "buy");
  assert.equal(change.solDeltaLamports, "-100000000");
  assert.equal(change.feeLamports, "5000");
  assert.deepEqual(change.tokenChanges, [{ mint: MINT, deltaRaw: "500", decimals: 5 }]);
});

test("sell via wrapped SOL account is folded into SOL", () => {
  const change = extractWalletChange("sig", tx(1_000_000_000, 999_995_000, [balance(MINT, "500"), balance(WSOL_MINT, "0", 2)], [balance(MINT, "0"), balance(WSOL_MINT, "200000000", 2)]), OWNER);
  assert.equal(change.kind, "sell");
  assert.equal(change.solDeltaLamports, "200000000");
});

test("failed transaction is not counted as a trade", () => {
  const change = extractWalletChange("sig", tx(1_000_000_000, 999_995_000, [], [], { InstructionError: [0, "Custom"] }), OWNER);
  assert.equal(change.failed, true);
  assert.deepEqual(summarizeTradedTokens([change]), []);
});

test("traded token summary aggregates buys and sells", () => {
  const buy = extractWalletChange("a", tx(1_000_000_000, 899_995_000, [], [balance(MINT, "500")]), OWNER);
  const sell = extractWalletChange("b", tx(899_995_000, 1_049_990_000, [balance(MINT, "500")], [balance(MINT, "100")]), OWNER);
  const [summary] = summarizeTradedTokens([buy, sell]);
  assert.equal(summary.boughtRaw, "500");
  assert.equal(summary.soldRaw, "400");
  assert.equal(summary.solSpentLamports, "100000000");
  assert.equal(summary.solReceivedLamports, "150000000");
  assert.equal(summary.trades, 2);
});

test("invalid wallet address is rejected", () => {
  assert.throws(() => parseWalletAddress("not-a-wallet"), WalletAddressError);
  assert.equal(parseWalletAddress(` ${OWNER} `), OWNER);
});
