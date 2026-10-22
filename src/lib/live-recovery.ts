import { attachRecoveredSignature, confirmLiveEntry, confirmLiveExit, failLiveOrder, isSignatureRecorded, getLiveExpectedHoldings, listPendingLiveOrders, releaseOrphanClosingPositions, setRuntimeValue, updateTradingControls } from "@/db/repository";
import { fetchLiveExecution, hasLiveKeypair, liveConnection, loadLiveKeypair, type LiveSide, type LiveSwapExecution } from "./live";
import { decideRecovery, matchManualSwap, reconcileHoldings, type SignatureState } from "./live-safety";
import { getWalletActivity, getWalletHoldings, type WalletChange } from "./wallet-tracker";
import { sendAlertOnce } from "./alerts";

export type RecoveryChain = {
  getSignatureStatus(signature: string): Promise<SignatureState>;
  getBlockHeight(): Promise<number>;
  fetchExecution(signature: string, wallet: string, tokenMint: string, side: LiveSide): Promise<LiveSwapExecution | null>;
  walletActivity(wallet: string): Promise<WalletChange[]>;
};

export function rpcRecoveryChain(): RecoveryChain {
  const connection = liveConnection();
  return {
    async getSignatureStatus(signature) { const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }); return value[0] ? { err: value[0].err, confirmationStatus: value[0].confirmationStatus ?? null } : null; },
    getBlockHeight: () => connection.getBlockHeight("confirmed"),
    fetchExecution: (signature, wallet, tokenMint, side) => fetchLiveExecution(connection, signature, wallet, tokenMint, side),
    walletActivity: (wallet) => getWalletActivity(wallet, 25),
  };
}

// Orders younger than this may still be in flight on the live path.
export const RECOVERY_MIN_AGE_MS = 90_000;

export async function recoverLiveOrders(chain: RecoveryChain = rpcRecoveryChain(), minAgeMs = RECOVERY_MIN_AGE_MS) {
  const results: Array<{ orderId: string; side: string; action: string; detail?: string }> = [];
  const pending = await listPendingLiveOrders(minAgeMs);
  const blockHeight = pending.length ? await chain.getBlockHeight() : 0;
  for (const order of pending) {
    const side = order.side as LiveSide;
    try {
      // A reserved order may still be building its swap; give the live path ample time before declaring it abandoned.
      if (!order.signature && Date.now() - order.updatedAt.getTime() < 2 * minAgeMs) { results.push({ orderId: order.id, side, action: "wait" }); continue; }
      let signature = order.signature;
      // Browser-wallet orders: the wallet broadcasts before the app learns the signature, so look for the swap in the wallet's history.
      if (!signature && order.origin === "manual" && order.wallet) {
        const changes = await chain.walletActivity(order.wallet), recorded = new Set<string>();
        for (const change of changes) if (await isSignatureRecorded(change.signature)) recorded.add(change.signature);
        const match = matchManualSwap(changes, order.mint, side, order.createdAt, recorded);
        if (match && await attachRecoveredSignature(order.id, match)) signature = match;
        else if (order.lastValidBlockHeight === null || BigInt(blockHeight) <= order.lastValidBlockHeight) { results.push({ orderId: order.id, side, action: "wait", detail: "Manual order not found in wallet yet." }); continue; }
      }
      const status = signature ? await chain.getSignatureStatus(signature) : null;
      const decision = decideRecovery({ signature, status, blockHeight, lastValidBlockHeight: order.lastValidBlockHeight });
      if (decision === "wait") { results.push({ orderId: order.id, side, action: "wait" }); continue; }
      if (decision === "fail") {
        const reason = !signature && order.origin === "manual" ? "Wallet never broadcast a matching swap before the blockhash expired." : !signature ? "Never broadcast (no signature persisted)." : status?.err ? `Failed on-chain: ${JSON.stringify(status.err)}` : "Blockhash expired without landing.";
        await failLiveOrder(order.id, `Recovery: ${reason}`);
        results.push({ orderId: order.id, side, action: "failed", detail: reason });
        continue;
      }
      if (!order.wallet) throw new Error("Confirmed order has no wallet recorded.");
      const execution = await chain.fetchExecution(signature!, order.wallet, order.mint, side);
      if (!execution) { results.push({ orderId: order.id, side, action: "wait", detail: "Transaction details not yet available." }); continue; }
      const saved = side === "buy" ? await confirmLiveEntry(order.id, execution) : await confirmLiveExit(order.id, execution);
      results.push({ orderId: order.id, side, action: saved?.duplicate ? "already-confirmed" : "confirmed" });
      void sendAlertOnce(`recovered:${order.id}`, 24 * 60 * 60_000, { type: "live.order.recovered", severity: "warning", title: `LIVE ${side} recovered`, message: `Order ${order.id} confirmed by recovery job (${execution.signature}).`, data: { orderId: order.id, signature: execution.signature } });
    } catch (error) {
      results.push({ orderId: order.id, side, action: "error", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const released = await releaseOrphanClosingPositions();
  for (const positionId of released) results.push({ orderId: "-", side: "sell", action: "released-closing", detail: positionId });
  if (results.some((item) => item.action === "error")) void sendAlertOnce("recovery-errors", 30 * 60_000, { type: "live.recovery.error", severity: "critical", title: "LIVE recovery errors", message: results.filter((item) => item.action === "error").map((item) => `${item.orderId}: ${item.detail}`).join("; ") });
  return results;
}

// Compares wallet balances with open live positions. Missing tokens pause entries; extra tokens are only reported.
export async function reconcileLiveWallet(readHoldings: (wallet: string) => Promise<Map<string, bigint>> = async (wallet) => new Map((await getWalletHoldings(wallet)).tokens.map((item) => [item.mint, BigInt(item.amountRaw)]))) {
  // Trading controls are shared with shadow mode, so only reconcile (and possibly pause) when actually trading live.
  if ((process.env.TRADING_MODE ?? "paper") !== "live") return { skipped: true as const, reason: "TRADING_MODE is not live." };
  if (!hasLiveKeypair()) return { skipped: true as const, reason: "No live keypair configured." };
  const wallet = loadLiveKeypair().publicKey.toBase58();
  const [{ expected, pendingMints }, actual] = await Promise.all([getLiveExpectedHoldings(), readHoldings(wallet)]);
  const result = reconcileHoldings(expected, actual, pendingMints);
  const record = { checkedAt: new Date().toISOString(), wallet, ok: result.ok, missing: result.missing, surplus: result.surplus, skippedMints: [...pendingMints] };
  await setRuntimeValue("live-reconciliation", record);
  if (!result.ok) {
    await updateTradingControls(true, `Reconciliation mismatch: ${result.missing.map((item) => item.mint.slice(0, 6)).join(", ")}`);
    void sendAlertOnce(`reconcile:${result.missing.map((item) => `${item.mint}:${item.actualRaw}`).join("|")}`, 60 * 60_000, { type: "live.reconciliation.mismatch", severity: "critical", title: "LIVE wallet mismatch — entries paused", message: result.missing.map((item) => `${item.mint}: expected ${item.expectedRaw}, wallet ${item.actualRaw}`).join("; "), data: record });
  }
  return { skipped: false as const, ...record };
}
