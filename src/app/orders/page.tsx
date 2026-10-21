import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { listTriggerOrders } from "@/db/repository";
import { TriggerList, type TriggerRow } from "@/components/trigger-list";
import { triggersEnabled } from "@/lib/trigger-engine";
export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const rows: TriggerRow[] = (await listTriggerOrders()).map((row) => ({ ...row, expiresAt: row.expiresAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), filledAt: row.filledAt?.toISOString() ?? null }));
  const pending = rows.filter((row) => row.status === "active" || row.status === "triggered"), history = rows.filter((row) => row.status !== "active" && row.status !== "triggered");
  return <main className="positions-shell"><header className="detail-top"><Link href="/"><ArrowLeft size={16}/> Tổng quan</Link><span className="mode-pill">{triggersEnabled() ? "TRIGGER ENGINE ON" : "ENGINE OFF · TRADING_MODE≠shadow"}</span></header><div className="positions-content">
    <div className="page-title"><div><span className="eyebrow">TRIGGER ORDERS</span><h1>Lệnh điều kiện</h1><p>Limit mua, take profit, stop loss và trailing stop theo market cap. Chế độ shadow — không dùng tiền thật. Tạo lệnh từ trang chi tiết token.</p></div></div>
    <section className="panel wallet-panel"><div className="panel-head"><div><span className="eyebrow">PENDING</span><h2>Đang chờ</h2></div><span>{pending.length} lệnh</span></div><TriggerList rows={pending} showToken/></section>
    <section className="panel"><div className="panel-head"><div><span className="eyebrow">HISTORY</span><h2>Lịch sử</h2></div><span>{history.length} lệnh</span></div><TriggerList rows={history} showToken/></section>
  </div></main>;
}
