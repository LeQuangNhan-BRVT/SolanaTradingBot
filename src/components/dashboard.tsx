import { Activity, CircleDollarSign, Crosshair, LayoutDashboard, Pause, Settings, Shield, Wallet } from "lucide-react";
import type { Candidate } from "@/lib/types";
import { AddCaForm } from "./add-ca-form";
import { TokenRow } from "./token-row";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cash = (value: number | null) => value === null ? "Chưa rõ" : money.format(value);
const pct = (value: number | null) => value === null ? "—" : `${value}%`;

export function Dashboard({ candidates, databaseConnected }: { candidates: Candidate[]; databaseConnected: boolean }) {
  const eligible = candidates.filter((item) => item.status === "eligible").length;
  const rejected = candidates.filter((item) => item.status === "rejected").length;
  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">A</div><div><strong>AEGIS</strong><span>SOLANA TERMINAL</span></div></div>
      <nav><a className="active" href="#"><LayoutDashboard size={18}/> Tổng quan</a><a href="#watchlist"><Crosshair size={18}/> Watchlist <b>{candidates.length}</b></a><a href="#"><Activity size={18}/> Thị trường</a><a href="#"><Wallet size={18}/> Vị thế</a><a href="#"><Shield size={18}/> Risk engine</a></nav>
      <div className="sidebar-bottom"><a href="#"><Settings size={18}/> Cài đặt</a><div className="system-status"><i/><div><strong>{databaseConnected ? "Database đã kết nối" : "Database offline"}</strong><span>Paper mode · Live trading đã khóa</span></div></div></div>
    </aside>
    <section className="workspace">
      <header className="topbar"><div><span className="eyebrow">SYSTEM STATUS</span><strong>{databaseConnected ? "PostgreSQL online" : "PostgreSQL chưa cấu hình"}</strong></div><span className="mode-pill">PAPER MODE</span></header>
      <div className="content">
        <div className="page-title"><div><span className="eyebrow">CONTROL CENTER</span><h1>Tổng quan giao dịch</h1><p>Nhấn vào một token trong watchlist để xem holder, funding và bundle evidence.</p></div><div className="title-actions"><button className="pause-button"><Pause size={16}/> Pause entries</button><AddCaForm/></div></div>
        <section className="metric-grid">
          <article><div className="metric-icon green"><CircleDollarSign size={19}/></div><span>Chế độ</span><strong>Paper</strong><small>Không dùng tiền thật</small></article>
          <article><div className="metric-icon blue"><Activity size={19}/></div><span>Watchlist</span><strong>{candidates.length} tokens</strong><small>Dữ liệu PostgreSQL</small></article>
          <article><div className="metric-icon amber"><Crosshair size={19}/></div><span>Đủ điều kiện</span><strong>{eligible}</strong><small>Vượt tất cả hard gate</small></article>
          <article><div className="metric-icon violet"><Shield size={19}/></div><span>Đã loại</span><strong>{rejected}</strong><small>Có hard gate thất bại</small></article>
        </section>
        <section className="panel" id="watchlist">
          <div className="panel-head"><div><span className="eyebrow">DATABASE CANDIDATES</span><h2>Watchlist</h2></div><AddCaForm/></div>
          <div className="table-wrap"><table><thead><tr><th>Token</th><th>Launchpad</th><th>Đã migrate</th><th>Risk</th><th>Bundle</th><th>Creator cluster</th><th>Liquidity</th><th>Volume 1h</th><th>Trạng thái</th></tr></thead><tbody>{candidates.length === 0 ? <tr><td colSpan={9}>Chưa có token. Hãy thêm CA để bắt đầu xác minh.</td></tr> : candidates.map((token) => <TokenRow key={token.mint} token={token} cash={cash(token.liquidityUsd)} volume={cash(token.volume1hUsd)} bundle={pct(token.bundlePct)} cluster={pct(token.clusterPct)}/>)}</tbody></table></div>
        </section>
        <p className="paper-notice"><Shield size={15}/> Paper Mode: không tải private key và không gửi transaction lên Solana.</p>
      </div>
    </section>
  </main>;
}
