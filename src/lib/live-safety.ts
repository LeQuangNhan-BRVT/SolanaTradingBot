import type { WalletChange } from "./wallet-tracker";

// ---------- Hard caps for live entries (env only, never editable from the dashboard) ----------
export type LiveLimits = { maxEntryLamports: bigint; dailySpendLimitLamports: bigint; minSolReserveLamports: bigint };
// Headroom for network fees, priority fees and token-account rent on top of the entry size.
export const LIVE_FEE_BUFFER_LAMPORTS = 5_000_000n;

export function liveLimitsFromEnv(): LiveLimits {
  return {
    maxEntryLamports: BigInt(process.env.LIVE_MAX_ENTRY_LAMPORTS ?? "100000000"),
    dailySpendLimitLamports: BigInt(process.env.LIVE_DAILY_SPEND_LIMIT_LAMPORTS ?? "300000000"),
    minSolReserveLamports: BigInt(process.env.LIVE_MIN_SOL_RESERVE_LAMPORTS ?? "50000000"),
  };
}

export function assessLiveEntryLimits(input: { entryLamports: bigint; spentTodayLamports: bigint; walletLamports: bigint | null }, limits: LiveLimits) {
  const reasons: string[] = [];
  if (input.entryLamports > limits.maxEntryLamports) reasons.push(`Entry ${input.entryLamports} lamports vượt LIVE_MAX_ENTRY_LAMPORTS ${limits.maxEntryLamports}.`);
  if (input.spentTodayLamports + input.entryLamports > limits.dailySpendLimitLamports) reasons.push(`Tổng SOL chi hôm nay sẽ vượt LIVE_DAILY_SPEND_LIMIT_LAMPORTS ${limits.dailySpendLimitLamports}.`);
  if (input.walletLamports === null) reasons.push("Không đọc được số dư ví live.");
  else if (input.walletLamports - input.entryLamports - LIVE_FEE_BUFFER_LAMPORTS < limits.minSolReserveLamports) reasons.push(`Số dư ví sau lệnh sẽ thấp hơn mức dự trữ ${limits.minSolReserveLamports} lamports.`);
  return { accepted: reasons.length === 0, reasons };
}

// ---------- Recovery of orders left behind by a crash or timeout ----------
export type SignatureState = { err: unknown; confirmationStatus?: "processed" | "confirmed" | "finalized" | null } | null;
export type RecoveryDecision = "confirm" | "fail" | "wait";

export function decideRecovery(input: { signature: string | null; status: SignatureState; blockHeight: number; lastValidBlockHeight: bigint | null }): RecoveryDecision {
  // The signature is persisted before sending, so an order without one was never broadcast.
  if (!input.signature) return "fail";
  if (input.status?.err) return "fail";
  if (input.status?.confirmationStatus === "confirmed" || input.status?.confirmationStatus === "finalized") return "confirm";
  if (input.status) return "wait";
  // Not seen by the cluster: only safe to fail once its blockhash can no longer be included.
  if (input.lastValidBlockHeight !== null && BigInt(input.blockHeight) > input.lastValidBlockHeight) return "fail";
  return "wait";
}

// ---------- Execution amounts from the confirmed transaction itself ----------
export type ExecutionAmounts = { tokenAmountRaw: string; lamports: string; feeLamports: string };

// Buy: lamports is the total SOL that left the wallet (swap + fees + rent). Sell: net SOL received after fees.
export function executionFromChange(change: WalletChange, side: "buy" | "sell", tokenMint: string): ExecutionAmounts {
  if (change.failed) throw new Error(`Transaction ${change.signature} failed on-chain.`);
  const token = change.tokenChanges.find((item) => item.mint === tokenMint);
  const tokenDelta = BigInt(token?.deltaRaw ?? "0"), solDelta = BigInt(change.solDeltaLamports), fee = BigInt(change.feeLamports);
  if (side === "buy") {
    if (tokenDelta <= 0n) throw new Error(`Buy ${change.signature} did not increase ${tokenMint} balance.`);
    return { tokenAmountRaw: tokenDelta.toString(), lamports: (fee - solDelta).toString(), feeLamports: fee.toString() };
  }
  if (tokenDelta >= 0n) throw new Error(`Sell ${change.signature} did not decrease ${tokenMint} balance.`);
  return { tokenAmountRaw: (-tokenDelta).toString(), lamports: (solDelta - fee).toString(), feeLamports: fee.toString() };
}

// ---------- Wallet vs database reconciliation ----------
export type HoldingMismatch = { mint: string; expectedRaw: string; actualRaw: string };
export function reconcileHoldings(expected: Map<string, bigint>, actual: Map<string, bigint>, pendingMints: Set<string>) {
  const missing: HoldingMismatch[] = [], surplus: HoldingMismatch[] = [];
  for (const mint of new Set([...expected.keys(), ...actual.keys()])) {
    if (pendingMints.has(mint)) continue;
    const want = expected.get(mint) ?? 0n, have = actual.get(mint) ?? 0n;
    if (have < want) missing.push({ mint, expectedRaw: want.toString(), actualRaw: have.toString() });
    else if (have > want && want > 0n) surplus.push({ mint, expectedRaw: want.toString(), actualRaw: have.toString() });
  }
  return { ok: missing.length === 0, missing, surplus };
}

// ---------- Fast price loop: cheap estimate decides when a real quote is worth fetching ----------
export function estimatePositionPnlBps(input: { quantityRaw: string; decimals: number; costLamports: string; tokenUsd: number; solUsd: number }) {
  const cost = Number(input.costLamports);
  if (!(cost > 0) || !(input.solUsd > 0) || !(input.tokenUsd >= 0)) return null;
  const valueLamports = Number(input.quantityRaw) / 10 ** input.decimals * input.tokenUsd / input.solUsd * 1e9;
  return Math.round((valueLamports - cost) / cost * 10_000);
}

export const shouldCheckExit = (estimatedBps: number, settings: { stopLossBps: number; takeProfitBps: number }, marginBps = 300) => estimatedBps <= settings.stopLossBps + marginBps || estimatedBps >= settings.takeProfitBps - marginBps;

// ---------- Manual (browser wallet) orders ----------
// The wallet broadcasts before the app learns the signature; if the browser closed in between, find the swap in the wallet's history.
export function matchManualSwap(changes: WalletChange[], mint: string, side: "buy" | "sell", since: Date, excludeSignatures: Set<string>) {
  const earliest = since.getTime() - 120_000;
  const match = changes
    .filter((change) => !change.failed && !excludeSignatures.has(change.signature) && (change.blockTime?.getTime() ?? 0) >= earliest)
    .find((change) => change.tokenChanges.some((token) => token.mint === mint && (side === "buy" ? BigInt(token.deltaRaw) > 0n : BigInt(token.deltaRaw) < 0n)));
  return match?.signature ?? null;
}

export function isValidSignature(value: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value);
}
