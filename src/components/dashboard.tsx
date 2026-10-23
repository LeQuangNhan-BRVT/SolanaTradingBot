import { Activity, CircleDollarSign, Crosshair, Shield } from "lucide-react";
import type { Candidate } from "@/lib/types";
import { AddCaForm } from "./add-ca-form";
import { WatchlistTable } from "./watchlist-table";
import { EntryControls } from "./entry-controls";
import { AttentionPanel } from "./attention-panel";
import type { AttentionItem } from "@/lib/attention";

const MODE: Record<string, { label: string; hint: string; notice: string }> = {
  paper: { label: "Paper", hint: "Chỉ nghiên cứu, bot không vào lệnh", notice: "Paper mode: bot không vào lệnh và không gửi transaction." },
  shadow: { label: "Shadow", hint: "Lệnh mô phỏng, không dùng tiền thật", notice: "Shadow mode: bot và lệnh điều kiện chỉ mô phỏng, không gửi transaction." },
  live: { label: "Live", hint: "Bot giao dịch bằng tiền thật", notice: "Live mode: bot có thể gửi giao dịch thật từ ví nóng, theo giới hạn cứng trong Live safety." },
};

export function Dashboard({ candidates, attention = [], databaseConnected, entriesPaused, haltAll = false, archived = false, activeTag = null, mode = "paper" }: { candidates: Candidate[]; attention?: AttentionItem[]; databaseConnected: boolean; entriesPaused: boolean; haltAll?: boolean; mode?: string; archived?: boolean; activeTag?: string | null }) {
  const eligible = candidates.filter((item) => item.status === "eligible").length;
  const autoTrade = candidates.filter((item) => item.watch?.autoTrade).length;
  return <main className="content">
        <div className="page-title"><div><span className="eyebrow">CONTROL CENTER</span><h1>Tổng quan giao dịch</h1><p>Nhấn vào một token trong watchlist để xem holder, funding và bundle evidence.</p></div><div className="title-actions"><EntryControls initialPaused={entriesPaused} initialHalted={haltAll}/><AddCaForm/></div></div>
        <section className="metric-grid">
          <article><div className="metric-icon green"><CircleDollarSign size={19}/></div><span>Chế độ</span><strong>{MODE[mode]?.label ?? mode}</strong><small>{MODE[mode]?.hint ?? ""}</small></article>
          <article><div className="metric-icon blue"><Activity size={19}/></div><span>Watchlist</span><strong>{candidates.length} tokens</strong><small>Dữ liệu PostgreSQL</small></article>
          <article><div className="metric-icon amber"><Crosshair size={19}/></div><span>Đủ điều kiện</span><strong>{eligible}</strong><small>Vượt tất cả hard gate</small></article>
          <article><div className="metric-icon violet"><Shield size={19}/></div><span>Bật auto-trade</span><strong>{autoTrade}</strong><small>Bot chỉ tự vào lệnh các token này</small></article>
        </section>
        {!archived && <AttentionPanel items={attention}/>}
        <section className="panel" id="watchlist">
          <div className="panel-head"><div><span className="eyebrow">DATABASE CANDIDATES</span><h2>Watchlist</h2></div><div className="watch-tabs"><a className={archived ? "" : "active"} href="/#watchlist">Đang theo dõi</a><a className={archived ? "active" : ""} href="/?view=archived#watchlist">Lưu trữ</a></div></div>
          <WatchlistTable candidates={candidates} archived={archived} initialTag={activeTag}/>
        </section>
        <p className="paper-notice"><Shield size={15}/> {MODE[mode]?.notice ?? ""}{databaseConnected ? "" : " · Database chưa cấu hình: đang hiển thị dữ liệu trống."}</p>
  </main>;
}
