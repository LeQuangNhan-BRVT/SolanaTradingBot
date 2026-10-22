import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { getLiveSpentTodayLamports, getRuntimeValue, getTradingControls, listRecentLiveOrders } from "@/db/repository";
import { liveTradingConfigError } from "@/lib/live";
import { liveLimitsFromEnv } from "@/lib/live-safety";
import { formatUnits } from "@/lib/wallet-tracker";
import { EntryControls } from "@/components/entry-controls";
export const dynamic = "force-dynamic";

const sol = (lamports: string | bigint | null | undefined) => lamports === null || lamports === undefined ? "—" : `${formatUnits(lamports, 9)} SOL`;
const short = (value: string | null) => value ? `${value.slice(0, 6)}…${value.slice(-5)}` : "—";
type Reconciliation = { checkedAt: string; wallet: string; ok: boolean; missing: Array<{ mint: string; expectedRaw: string; actualRaw: string }>; surplus: Array<{ mint: string; expectedRaw: string; actualRaw: string }>; skippedMints: string[] };
const statusLabel: Record<string, string> = { quoted: "Đã reserve", simulated: "Đã ký, chờ gửi", submitted: "Đã gửi", confirmed: "Đã khớp", failed: "Thất bại", cancelled: "Đã hủy", created: "Mới tạo" };

export default async function LiveSafetyPage() {
  const [controls, spent, reconciliation, orders] = await Promise.all([getTradingControls(), getLiveSpentTodayLamports(), getRuntimeValue<Reconciliation>("live-reconciliation"), listRecentLiveOrders()]);
  const limits = liveLimitsFromEnv(), configError = liveTradingConfigError(), pending = orders.filter((order) => ["quoted", "simulated", "submitted"].includes(order.status));
  return <main className="positions-shell"><header className="detail-top"><Link href="/"><ArrowLeft size={16}/> Tổng quan</Link><span className={`mode-pill${controls.haltAll ? " halted" : ""}`}>{controls.haltAll ? "TRADING HALTED" : configError ? "LIVE DISABLED" : "LIVE ARMED"}</span></header><div className="positions-content">
    <div className="page-title"><div><span className="eyebrow">LIVE SAFETY</span><h1>An toàn giao dịch live</h1><p>{configError ? `Live chưa bật: ${configError}` : "Live đang được cấu hình. Mọi lệnh đều qua giới hạn cứng, kill switch và job phục hồi."}</p></div><div className="title-actions"><EntryControls initialPaused={controls.entriesPaused} initialHalted={controls.haltAll}/></div></div>
    <section className="position-metrics">
      <article><span>Trạng thái</span><strong className={controls.haltAll ? "pnl-negative" : controls.entriesPaused ? "" : "pnl-positive"}>{controls.haltAll ? "Chặn tuyệt đối" : controls.entriesPaused ? "Pause entry" : "Đang chạy"}</strong><small className="field-hint">{controls.reason ?? ""}</small></article>
      <article><span>SOL đã cam kết hôm nay</span><strong>{sol(spent)}</strong><small className="field-hint">Giới hạn {sol(limits.dailySpendLimitLamports)}</small></article>
      <article><span>Tối đa mỗi lệnh</span><strong>{sol(limits.maxEntryLamports)}</strong><small className="field-hint">Dự trữ tối thiểu {sol(limits.minSolReserveLamports)}</small></article>
      <article><span>Lệnh đang chờ</span><strong className={pending.length ? "pnl-negative" : ""}>{pending.length}</strong><small className="field-hint">Job phục hồi chạy mỗi 30 giây</small></article>
    </section>
    <section className="panel wallet-panel"><div className="panel-head"><div><span className="eyebrow">RECONCILIATION</span><h2>Đối soát ví và vị thế</h2></div><span>{reconciliation ? new Date(reconciliation.checkedAt).toLocaleString("vi-VN") : "Chưa chạy"}</span></div>
      {!reconciliation ? <p className="empty-state wallet-hint">Chưa có kết quả. Đối soát chỉ chạy khi TRADING_MODE=live và có keypair.</p> : <div className="wallet-hint">
        <p className={reconciliation.ok ? "pnl-positive" : "pnl-negative"}>{reconciliation.ok ? "Khớp: số token trong ví đủ cho mọi vị thế mở." : "LỆCH: ví thiếu token so với vị thế — entry đã tự động pause."}</p>
        <p className="field-hint">Ví {short(reconciliation.wallet)} · bỏ qua {reconciliation.skippedMints.length} token đang có lệnh chờ</p>
        {[...reconciliation.missing.map((item) => ({ ...item, kind: "Thiếu" })), ...reconciliation.surplus.map((item) => ({ ...item, kind: "Dư" }))].map((item) => <p key={item.mint + item.kind} className={item.kind === "Thiếu" ? "pnl-negative" : "field-hint"}>{item.kind} <code>{short(item.mint)}</code>: DB {item.expectedRaw} · ví {item.actualRaw}</p>)}
      </div>}
    </section>
    <section className="panel"><div className="panel-head"><div><span className="eyebrow">ORDER LEDGER</span><h2>Lệnh live gần đây</h2></div><span>{orders.length} lệnh</span></div><div className="table-wrap"><table className="compact-table"><thead><tr><th>Thời gian</th><th>Token</th><th>Nguồn</th><th>Chiều</th><th>Trạng thái</th><th>SOL thực</th><th>Phí</th><th>Transaction</th><th>Lỗi</th></tr></thead><tbody>{orders.length === 0 ? <tr><td colSpan={9}>Chưa có lệnh live.</td></tr> : orders.map((order) => <tr key={order.id}><td>{order.createdAt.toLocaleString("vi-VN")}</td><td><Link href={`/tokens/${order.mint}`}>{order.symbol}</Link></td><td>{order.origin === "manual" ? <span className="tag">VÍ {short(order.wallet)}</span> : <span className="tag">BOT</span>}</td><td><span className={`activity-kind ${order.side === "buy" ? "buy" : "sell"}`}>{order.side === "buy" ? "Mua" : "Bán"}</span></td><td>{statusLabel[order.status] ?? order.status}</td><td>{sol(order.filledLamports)}</td><td>{sol(order.feeLamports)}</td><td>{order.signature ? <a className="external" href={`https://solscan.io/tx/${order.signature}`} target="_blank" rel="noreferrer">{short(order.signature)} <ExternalLink size={11}/></a> : "—"}</td><td className="field-hint" title={order.error ?? ""}>{order.error ? order.error.slice(0, 80) : ""}</td></tr>)}</tbody></table></div></section>
  </div></main>;
}
