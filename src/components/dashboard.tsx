import { Activity, CircleDollarSign, Crosshair, Eye, HeartPulse, LayoutDashboard, Settings, Shield, Wallet } from "lucide-react";
import type { Candidate } from "@/lib/types";
import { AddCaForm } from "./add-ca-form";
import { TokenRow } from "./token-row";
import { EntryControls } from "./entry-controls";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cash = (value: number | null) => value === null ? "Chưa rõ" : money.format(value);
const pct = (value: number | null) => value === null ? "—" : `${value}%`;

export function Dashboard({ candidates, databaseConnected, entriesPaused, archived = false, activeTag = null }: { candidates: Candidate[]; databaseConnected: boolean; entriesPaused: boolean; archived?: boolean; activeTag?: string | null }) {
  const eligible = candidates.filter((item) => item.status === "eligible").length;
  const autoTrade = candidates.filter((item) => item.watch?.autoTrade).length;
  const tags = [...new Set(candidates.flatMap((item) => item.watch?.tags ?? []))].sort();
  const visible = activeTag ? candidates.filter((item) => item.watch?.tags.includes(activeTag)) : candidates;
  const viewHref = (tag: string | null) => { const params = new URLSearchParams(); if (archived) params.set("view", "archived"); if (tag) params.set("tag", tag); const query = params.toString(); return query ? `/?${query}#watchlist` : "/#watchlist"; };
  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">A</div><div><strong>AEGIS</strong><span>SOLANA TERMINAL</span></div></div>
      <nav><a className="active" href="#"><LayoutDashboard size={18}/> Tổng quan</a><a href="#watchlist"><Crosshair size={18}/> Watchlist <b>{candidates.length}</b></a><a href="/performance"><Activity size={18}/> Performance</a><a href="/positions"><Wallet size={18}/> Vị thế</a><a href="/wallets"><Eye size={18}/> Ví theo dõi</a><a href="#"><Shield size={18}/> Risk engine</a></nav>
      <div className="sidebar-bottom"><a href="/settings"><Settings size={18}/> Cài đặt</a><a href="/health"><HeartPulse size={18}/> System health</a><div className="system-status"><i/><div><strong>{databaseConnected ? "Database đã kết nối" : "Database offline"}</strong><span>Paper mode · Live trading đã khóa</span></div></div></div>
    </aside>
    <section className="workspace">
      <header className="topbar"><div><span className="eyebrow">SYSTEM STATUS</span><strong>{databaseConnected ? "PostgreSQL online" : "PostgreSQL chưa cấu hình"}</strong></div><span className="mode-pill">PAPER MODE</span></header>
      <div className="content">
        <div className="page-title"><div><span className="eyebrow">CONTROL CENTER</span><h1>Tổng quan giao dịch</h1><p>Nhấn vào một token trong watchlist để xem holder, funding và bundle evidence.</p></div><div className="title-actions"><EntryControls initialPaused={entriesPaused}/><AddCaForm/></div></div>
        <section className="metric-grid">
          <article><div className="metric-icon green"><CircleDollarSign size={19}/></div><span>Chế độ</span><strong>Paper</strong><small>Không dùng tiền thật</small></article>
          <article><div className="metric-icon blue"><Activity size={19}/></div><span>Watchlist</span><strong>{candidates.length} tokens</strong><small>Dữ liệu PostgreSQL</small></article>
          <article><div className="metric-icon amber"><Crosshair size={19}/></div><span>Đủ điều kiện</span><strong>{eligible}</strong><small>Vượt tất cả hard gate</small></article>
          <article><div className="metric-icon violet"><Shield size={19}/></div><span>Bật auto-trade</span><strong>{autoTrade}</strong><small>Bot chỉ tự vào lệnh các token này</small></article>
        </section>
        <section className="panel" id="watchlist">
          <div className="panel-head"><div><span className="eyebrow">DATABASE CANDIDATES</span><h2>Watchlist</h2></div><div className="watch-tabs"><a className={archived ? "" : "active"} href="/#watchlist">Đang theo dõi</a><a className={archived ? "active" : ""} href="/?view=archived#watchlist">Lưu trữ</a></div></div>
          {tags.length > 0 && <div className="tag-filter"><a className={activeTag ? "" : "active"} href={viewHref(null)}>Tất cả</a>{tags.map((tag) => <a key={tag} className={activeTag === tag ? "active" : ""} href={viewHref(tag)}>#{tag}</a>)}</div>}
          <div className="table-wrap"><table><thead><tr><th>Token</th><th>Giá</th><th>Launchpad</th><th>Đã migrate</th><th>Risk</th><th>Bundle</th><th>Creator cluster</th><th>Liquidity</th><th>Volume 1h</th><th>Trạng thái</th><th>Tags</th><th></th></tr></thead><tbody>{visible.length === 0 ? <tr><td colSpan={12}>{archived ? "Chưa có token nào được lưu trữ." : activeTag ? "Không có token với tag này." : "Chưa có token. Hãy thêm CA để bắt đầu xác minh."}</td></tr> : visible.map((token) => <TokenRow key={token.mint} token={token} cash={cash(token.liquidityUsd)} volume={cash(token.volume1hUsd)} bundle={pct(token.bundlePct)} cluster={pct(token.clusterPct)}/>)}</tbody></table></div>
        </section>
        <p className="paper-notice"><Shield size={15}/> Paper Mode: không tải private key và không gửi transaction lên Solana.</p>
      </div>
    </section>
  </main>;
}
