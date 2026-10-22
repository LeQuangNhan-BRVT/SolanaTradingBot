import { confirmLiveEntry, confirmLiveExit, createManualOrder, failLiveOrder, getCandidateDetail, getManualOrder, getTradingControls, listManualPositions, markManualOrderSubmitted } from "@/db/repository";
import { buildJupiterSwap, fetchLiveExecution, liveConnection, type LiveSide } from "./live";
import { isValidSignature } from "./live-safety";
import { fetchJupiterPrices } from "./price-feed";
import { getJupiterQuote } from "./shadow";
import { impliedMcapFromQuote, solToLamports } from "./triggers";
import { getTokenBalanceRaw, parseWalletAddress, WSOL_MINT } from "./wallet-tracker";

export class ManualTradeError extends Error { constructor(message: string, readonly status = 422) { super(message); } }

export function manualTradingConfigError() {
  return process.env.MANUAL_TRADING_ENABLED === "true" ? null : "Giao dịch thủ công đang tắt (đặt MANUAL_TRADING_ENABLED=true).";
}

export type ManualPrepareInput = { mint: string; side: LiveSide; wallet: string; amount: string; slippageBps: number };

export async function prepareManualTrade(input: ManualPrepareInput) {
  const configError = manualTradingConfigError();
  if (configError) throw new ManualTradeError(configError, 403);
  const controls = await getTradingControls();
  if (controls.haltAll) throw new ManualTradeError(`Giao dịch đang bị chặn khẩn cấp: ${controls.reason ?? "không rõ lý do"}.`, 423);
  const wallet = parseWalletAddress(input.wallet);
  const detail = await getCandidateDetail(input.mint);
  if (!detail) throw new ManualTradeError("Token chưa có trong watchlist. Hãy thêm CA trước.", 404);
  const decimals = detail.token.decimals;
  if (decimals === null) throw new ManualTradeError("Token chưa có decimals.");

  let amountRaw: bigint;
  if (input.side === "buy") {
    const lamports = solToLamports(input.amount);
    if (!lamports || lamports < 1_000_000n) throw new ManualTradeError("Số SOL mua phải từ 0.001, tối đa 9 chữ số thập phân.");
    amountRaw = lamports;
  } else {
    const pct = Number(input.amount);
    if (!(pct > 0 && pct <= 100)) throw new ManualTradeError("Tỷ lệ bán phải trong khoảng 0–100%.");
    const balance = await getTokenBalanceRaw(wallet, input.mint);
    amountRaw = pct >= 100 ? balance : balance * BigInt(Math.round(pct * 100)) / 10_000n;
    if (amountRaw <= 0n) throw new ManualTradeError("Ví không có token này để bán.");
  }

  const quote = input.side === "buy" ? await getJupiterQuote(WSOL_MINT, input.mint, amountRaw.toString(), input.slippageBps) : await getJupiterQuote(input.mint, WSOL_MINT, amountRaw.toString(), input.slippageBps);
  const swap = await buildJupiterSwap(quote, wallet).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/prior credit|insufficient/i.test(message)) throw new ManualTradeError("Ví không đủ SOL cho giao dịch này (gồm phí mạng và tiền thuê tài khoản token).");
    throw error;
  });
  const lastValidBlockHeight = swap.lastValidBlockHeight ? BigInt(swap.lastValidBlockHeight) : BigInt(await liveConnection().getBlockHeight("confirmed")) + 300n;
  const solUsd = await fetchJupiterPrices([WSOL_MINT]).then((prices) => prices.get(WSOL_MINT) ?? null).catch(() => null);
  const impliedMcapUsd = solUsd && detail.token.supplyRaw ? impliedMcapFromQuote(quote, input.side, decimals, detail.token.supplyRaw, solUsd) : null;

  const warnings: string[] = [];
  if (detail.token.status !== "eligible") warnings.push(`Token đang "${detail.token.status}", chưa vượt hard gate.`);
  for (const check of detail.risk?.checks ?? []) if (check.status !== "pass") warnings.push(`${check.status === "fail" ? "✕" : "?"} ${check.label}: ${check.detail}`);
  const impactPct = Number(quote.priceImpactPct ?? "0") * 100;
  if (impactPct >= 10) warnings.push(`Price impact rất cao: ${impactPct.toFixed(2)}%.`); else if (impactPct >= 3) warnings.push(`Price impact cao: ${impactPct.toFixed(2)}%.`);
  if (input.side === "sell" && !(await listManualPositions(input.mint)).some((position) => position.wallet === wallet)) warnings.push("App chưa ghi nhận vị thế của ví này cho token này; PnL sẽ không được tính cho lệnh bán.");

  const order = await createManualOrder({ mint: input.mint, side: input.side, wallet, requestedAmountRaw: amountRaw.toString(), quote, lastValidBlockHeight });
  return {
    orderId: order.id,
    transaction: swap.swapTransaction!,
    preview: { side: input.side, symbol: detail.token.symbol, inAmount: quote.inAmount, outAmount: quote.outAmount, minOutAmount: quote.otherAmountThreshold ?? quote.outAmount, inputDecimals: input.side === "buy" ? 9 : decimals, outputDecimals: input.side === "buy" ? decimals : 9, priceImpactPct: impactPct, slippageBps: input.slippageBps, impliedMcapUsd, priorityFeeLamports: swap.prioritizationFeeLamports ?? null },
    warnings,
  };
}

// Records the wallet's signature, waits briefly for confirmation and books the fill. Anything unresolved is left to the recovery job.
export async function submitManualTrade(orderId: string, signature: string, waitMs = 45_000) {
  if (!isValidSignature(signature)) throw new ManualTradeError("Signature không hợp lệ.");
  const order = await getManualOrder(orderId);
  if (!order) throw new ManualTradeError("Không tìm thấy lệnh.", 404);
  if (!order.signature) { if (!(await markManualOrderSubmitted(orderId, signature))) throw new ManualTradeError("Lệnh không còn ở trạng thái chờ ký.", 409); }
  else if (order.signature !== signature) throw new ManualTradeError("Lệnh đã gắn với giao dịch khác.", 409);
  if (order.status === "confirmed") return { status: "confirmed" as const, signature, positionId: null };
  const connection = liveConnection(), deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = value[0];
    if (status?.err) { await failLiveOrder(orderId, `Failed on-chain: ${JSON.stringify(status.err)}`); return { status: "failed" as const, signature, error: JSON.stringify(status.err) }; }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      const execution = await fetchLiveExecution(connection, signature, order.wallet!, order.mint, order.side as LiveSide).catch(() => null);
      if (!execution) break;
      const saved = order.side === "buy" ? await confirmLiveEntry(orderId, execution) : await confirmLiveExit(orderId, execution);
      return { status: "confirmed" as const, signature, positionId: saved?.positionId ?? null, tokenAmountRaw: execution.tokenAmountRaw, lamports: execution.lamports, feeLamports: execution.feeLamports };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { status: "pending" as const, signature };
}
