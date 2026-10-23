import { Activity, CircleDollarSign, Crosshair, Shield } from "lucide-react";
import type { Candidate } from "@/lib/types";
import { AddCaForm } from "./add-ca-form";
import { TokenRow } from "./token-row";
import { EntryControls } from "./entry-controls";
import { WalletButton } from "./wallet-providers";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cash = (value: number | null) => value === null ? "Chưa rõ" : money.format(value);
const pct = (value: number | null) => value === null ? "—" : `${value}%`;
const MODE: Record<string, { label: string; hint: string; notice: string }> = {
  paper: { label: "Paper", hint: "Chỉ nghiên cứu, bot không vào lệnh", notice: "Paper mode: bot không vào lệnh và không gửi transaction." },
  shadow: { label: "Shadow", hint: "Lệnh mô phỏng, không dùng tiền thật", notice: "Shadow mode: bot và lệnh điều kiện chỉ mô phỏng, không gửi transaction." },
  live: { label: "Live", hint: "Bot giao dịch bằng tiền thật", notice: "Live mode: bot có thể gửi giao dịch thật từ ví nóng, theo giới hạn cứng trong Live safety." },
};

export function Dashboard({ candidates, databaseConnected, entriesPaused, haltAll = false, archived = false, activeTag = null, mode = "paper" }: { candidates: Candidate[]; databaseConnected: boolean; entriesPaused: boolean; haltAll?: boolean; mode?: string; archived?: boolean; activeTag?: string | null }) {
  const eligible = candidates.filter((item) => item.status === "eligible").length;
  const autoTrade = candidates.filter((item) => item.watch?.autoTrade).length;
  const tags = [...new Set(candidates.flatMap((item) => item.watch?.tags ?? []))].sort();
  const visible = activeTag ? candidates.filter((item) => item.watch?.tags.includes(activeTag)) : candidates;
  const viewHref = (tag: string | null) => { const params = new URLSearchParams(); if (archived) params.set("view", "archived"); if (tag) params.set("tag", tag); const query = params.toString(); return query ? `/?${query}#watchlist` : "/#watchlist"; };
  return <main className="content">
        <div className="page-title"><div><span className="eyebrow">CONTROL CENTER</span><h1>Tổng quan giao dịch</h1><p>Nhấn vào một token trong watchlist để xem holder, funding và bundle evidence.</p></div><div className="title-actions"><EntryControls initialPaused={entriesPaused} initialHalted={haltAll}/><AddCaForm/></div></div>
        <section className="metric-grid">
          <article><div className="metric-icon green"><CircleDollarSign size={19}/></div><span>Chế độ</span><strong>{MODE[mode]?.label ?? mode}</strong><small>{MODE[mode]?.hint ?? ""}</small></article>
          <article><div className="metric-icon blue"><Activity size={19}/></div><span>Watchlist</span><strong>{candidates.length} tokens</strong><small>Dữ liệu PostgreSQL</small></article>
          <article><div className="metric-icon amber"><Crosshair size={19}/></div><span>Đủ điều kiện</span><strong>{eligible}</strong><small>Vượt tất cả hard gate</small></article>
          <article><div className="metric-icon violet"><Shield size={19}/></div><span>Bật auto-trade</span><strong>{autoTrade}</strong><small>Bot chỉ tự vào lệnh các token này</small></article>
        </section>
        <section className="panel" id="watchlist">
          <div className="panel-head"><div><span className="eyebrow">DATABASE CANDIDATES</span><h2>Watchlist</h2></div><div className="watch-tabs"><a className={archived ? "" : "active"} href="/#watchlist">Đang theo dõi</a><a className={archived ? "active" : ""} href="/?view=archived#watchlist">Lưu trữ</a></div></div>
          {tags.length > 0 && <div className="tag-filter"><a className={activeTag ? "" : "active"} href={viewHref(null)}>Tất cả</a>{tags.map((tag) => <a key={tag} className={activeTag === tag ? "active" : ""} href={viewHref(tag)}>#{tag}</a>)}</div>}
          <div className="table-wrap"><table><thead><tr><th>Token</th><th>Giá</th><th>Launchpad</th><th>Đã migrate</th><th>Risk</th><th>Bundle</th><th>Creator cluster</th><th>Liquidity</th><th>Volume 1h</th><th>Trạng thái</th><th>Tags</th><th></th></tr></thead><tbody>{visible.length === 0 ? <tr><td colSpan={12}>{archived ? "Chưa có token nào được lưu trữ." : activeTag ? "Không có token với tag này." : "Chưa có token. Hãy thêm CA để bắt đầu xác minh."}</td></tr> : visible.map((token) => <TokenRow key={token.mint} token={token} cash={cash(token.liquidityUsd)} volume={cash(token.volume1hUsd)} bundle={pct(token.bundlePct)} cluster={pct(token.clusterPct)}/>)}</tbody></table></div>
        </section>
        <p className="paper-notice"><Shield size={15}/> {MODE[mode]?.notice ?? ""}{databaseConnected ? "" : " · Database chưa cấu hình: đang hiển thị dữ liệu trống."}</p>
  </main>;
}
