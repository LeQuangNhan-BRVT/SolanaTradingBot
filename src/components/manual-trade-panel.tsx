"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { ExternalLink } from "lucide-react";
import { WalletButton } from "./wallet-providers";
import { formatUnits } from "@/lib/wallet-tracker";
import { formatMcap, TRIGGER_LABELS, type TriggerType } from "@/lib/triggers";

type Preview = { side: "buy" | "sell"; symbol: string; inAmount: string; outAmount: string; minOutAmount: string; inputDecimals: number; outputDecimals: number; priceImpactPct: number; slippageBps: number; impliedMcapUsd: number | null; priorityFeeLamports: number | null };
type Prepared = { orderId: string; transaction: string; preview: Preview; warnings: string[] };
type Result = { status: "confirmed" | "failed" | "pending"; signature?: string; error?: string; tokenAmountRaw?: string; lamports?: string; feeLamports?: string };
export type WalletPosition = { wallet: string | null; quantityRaw: string; costLamports: string };
export type WalletAlert = { id: string; type: string; sellPctBps: number | null };

const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;

export function ManualTradePanel({ mint, symbol, decimals, enabled, disabledReason, halted, prefillSellPct, positions, alerts }: { mint: string; symbol: string; decimals: number | null; enabled: boolean; disabledReason: string | null; halted: boolean; prefillSellPct: number | null; positions: WalletPosition[]; alerts: WalletAlert[] }) {
  const router = useRouter();
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [side, setSide] = useState<"buy" | "sell">(prefillSellPct ? "sell" : "buy");
  const [amount, setAmount] = useState(prefillSellPct ? String(prefillSellPct) : "0.05"), [slippagePct, setSlippagePct] = useState("3");
  const [stage, setStage] = useState<"form" | "preparing" | "preview" | "signing" | "confirming" | "done">("form");
  const [prepared, setPrepared] = useState<Prepared | null>(null), [result, setResult] = useState<Result | null>(null), [error, setError] = useState<string | null>(null);
  const wallet = publicKey?.toBase58() ?? null;
  const mine = positions.filter((position) => position.wallet === wallet);

  async function prepare(nextSide = side, nextAmount = amount) {
    if (!wallet) return;
    setStage("preparing"); setError(null); setResult(null);
    try {
      const response = await fetch("/api/manual/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint, side: nextSide, wallet, amount: nextAmount.trim(), slippageBps: Math.round(Number(slippagePct) * 100) }) });
      const data = await response.json() as Prepared & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Không thể chuẩn bị giao dịch.");
      setPrepared(data); setStage("preview");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setStage("form"); }
  }

  async function cancel() {
    if (prepared) await fetch(`/api/manual/${prepared.orderId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }) }).catch(() => undefined);
    setPrepared(null); setStage("form");
  }

  async function sign() {
    if (!prepared) return;
    setStage("signing"); setError(null);
    let signature: string;
    try {
      signature = await sendTransaction(VersionedTransaction.deserialize(base64ToBytes(prepared.transaction)), connection);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A rejection in the wallet means nothing was sent; any other failure is left for the recovery job to verify.
      if (/reject|denied|cancel/i.test(message)) { await cancel(); setError("Bạn đã từ chối trên ví; lệnh đã hủy."); }
      else { setError(`Ví báo lỗi: ${message}. Nếu giao dịch đã được gửi, job phục hồi sẽ tìm và ghi nhận nó.`); setStage("form"); setPrepared(null); }
      return;
    }
    setStage("confirming");
    try {
      const response = await fetch(`/api/manual/${prepared.orderId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "submit", signature }) });
      setResult({ signature, ...(await response.json() as Result) });
    } catch { setResult({ status: "pending", signature }); }
    setStage("done"); router.refresh();
  }

  if (!enabled) return <p className="form-message">{disabledReason}</p>;
  const p = prepared?.preview;
  return <div className="manual-trade">
    <div className="manual-head"><WalletButton/>{wallet && <small className="field-hint">Ví {short(wallet)} · app không giữ private key, bạn ký mọi giao dịch trên ví.</small>}</div>
    {halted && <p className="form-message">Giao dịch đang bị chặn khẩn cấp; không thể tạo lệnh mới.</p>}
    {alerts.map((alert) => <div key={alert.id} className="trade-alert"><strong>{TRIGGER_LABELS[alert.type as TriggerType] ?? alert.type} đã chạm ngưỡng</strong><span>Bán {((alert.sellPctBps ?? 10_000) / 100).toFixed(0)}% vị thế</span><button className="halt-button" disabled={!wallet || halted || stage !== "form"} onClick={() => { const pct = String((alert.sellPctBps ?? 10_000) / 100); setSide("sell"); setAmount(pct); void prepare("sell", pct); }}>Bán ngay</button></div>)}
    {mine.length > 0 && <p className="field-hint">Vị thế ví đang theo dõi: {mine.map((position) => `${decimals === null ? position.quantityRaw : formatUnits(position.quantityRaw, decimals)} ${symbol} · giá vốn ${formatUnits(position.costLamports, 9)} SOL`).join("; ")}</p>}
    {stage === "form" || stage === "preparing" ? <form className="watch-form" onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
      <div className="watch-tabs"><button type="button" className={`tab-button${side === "buy" ? " active" : ""}`} onClick={() => { setSide("buy"); setAmount("0.05"); }}>Mua</button><button type="button" className={`tab-button${side === "sell" ? " active" : ""}`} onClick={() => { setSide("sell"); setAmount("100"); }}>Bán</button></div>
      <div className="watch-form-grid">
        <label>{side === "buy" ? "Số SOL chi" : "% số token trong ví"}<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)}/></label>
        {side === "sell" && <div className="pct-buttons">{["25", "50", "100"].map((pct) => <button type="button" key={pct} className={`tab-button${amount === pct ? " active" : ""}`} onClick={() => setAmount(pct)}>{pct}%</button>)}</div>}
        <label>Slippage tối đa (%)<input inputMode="decimal" value={slippagePct} onChange={(event) => setSlippagePct(event.target.value)}/></label>
      </div>
      {error && <p className="form-message">{error}</p>}
      <div className="modal-actions"><button className="primary-button" type="submit" disabled={!wallet || halted || stage === "preparing"}>{!wallet ? "Kết nối ví để giao dịch" : stage === "preparing" ? "Đang lấy quote…" : "Xem trước giao dịch"}</button></div>
    </form> : null}
    {p && (stage === "preview" || stage === "signing") && <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-label="Xác nhận giao dịch">
      <div className="modal-head"><div><span className="eyebrow">XÁC NHẬN · TIỀN THẬT</span><h2>{p.side === "buy" ? "Mua" : "Bán"} {p.symbol}</h2></div></div>
      <dl className="trade-preview">
        <div><dt>Trả</dt><dd>{formatUnits(p.inAmount, p.inputDecimals)} {p.side === "buy" ? "SOL" : p.symbol}</dd></div>
        <div><dt>Nhận dự kiến</dt><dd>{formatUnits(p.outAmount, p.outputDecimals)} {p.side === "buy" ? p.symbol : "SOL"}</dd></div>
        <div><dt>Nhận tối thiểu</dt><dd>{formatUnits(p.minOutAmount, p.outputDecimals)} {p.side === "buy" ? p.symbol : "SOL"}</dd></div>
        <div><dt>Price impact</dt><dd className={p.priceImpactPct >= 3 ? "pnl-negative" : ""}>{p.priceImpactPct.toFixed(2)}%</dd></div>
        <div><dt>Slippage tối đa</dt><dd>{(p.slippageBps / 100).toFixed(2)}%</dd></div>
        <div><dt>Market cap khớp</dt><dd>{formatMcap(p.impliedMcapUsd)}</dd></div>
        {p.priorityFeeLamports !== null && <div><dt>Priority fee</dt><dd>{formatUnits(String(p.priorityFeeLamports), 9)} SOL</dd></div>}
      </dl>
      {prepared.warnings.length > 0 && <div className="check-list">{prepared.warnings.map((warning) => <div key={warning} className="check-row fail"><span>{warning}</span></div>)}</div>}
      <p className="field-hint">Quote có hiệu lực khoảng 1 phút. Ví sẽ hiển thị giao dịch để bạn kiểm tra lần cuối trước khi ký.</p>
      <div className="modal-actions"><button className="ghost-button" disabled={stage === "signing"} onClick={() => void cancel()}>Hủy</button><button className="primary-button" disabled={stage === "signing"} onClick={() => void sign()}>{stage === "signing" ? "Đang chờ ví…" : "Ký trên ví"}</button></div>
    </section></div>}
    {stage === "confirming" && <p className="form-message">Đã gửi, đang chờ xác nhận on-chain…</p>}
    {stage === "done" && result && <div className="trade-result">
      <p className={result.status === "confirmed" ? "pnl-positive" : result.status === "failed" ? "pnl-negative" : ""}>{result.status === "confirmed" ? "Đã khớp và ghi nhận vị thế." : result.status === "failed" ? `Giao dịch thất bại on-chain: ${result.error ?? ""}` : "Chưa xác nhận kịp; job phục hồi sẽ tiếp tục theo dõi và ghi nhận."}</p>
      {result.signature && <a className="external" href={`https://solscan.io/tx/${result.signature}`} target="_blank" rel="noreferrer">{short(result.signature)} <ExternalLink size={11}/></a>}
      <div className="modal-actions"><button className="ghost-button" onClick={() => { setStage("form"); setPrepared(null); setResult(null); }}>Lệnh mới</button></div>
    </div>}
  </div>;
}
