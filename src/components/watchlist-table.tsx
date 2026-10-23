"use client";
import { useEffect, useMemo, useState } from "react";
import { Bookmark, Columns3, Search, X } from "lucide-react";
import type { Candidate, CandidateStatus } from "@/lib/types";
import { ariaSort, matchesQuery, nextSort, sortRows, type SortState } from "@/lib/table-tools";
import { TokenRow, type WatchColumn } from "./token-row";
import { useFeedback } from "./feedback";

type SortKey = "symbol" | WatchColumn;
type View = { name: string; query: string; statuses: CandidateStatus[]; autoTradeOnly: boolean; pinnedOnly: boolean; tag: string | null; sort: SortState<SortKey> };

const COLUMNS: Array<{ key: WatchColumn; label: string; sortable: boolean }> = [
  { key: "price", label: "Giá", sortable: true }, { key: "launchpad", label: "Launchpad", sortable: true }, { key: "migrated", label: "Đã migrate", sortable: true },
  { key: "risk", label: "Risk", sortable: true }, { key: "bundle", label: "Bundle", sortable: true }, { key: "cluster", label: "Creator cluster", sortable: true },
  { key: "liquidity", label: "Liquidity", sortable: true }, { key: "volume", label: "Volume 1h", sortable: true }, { key: "status", label: "Trạng thái", sortable: true }, { key: "tags", label: "Tags", sortable: false },
];
const STATUSES: Array<{ value: CandidateStatus; label: string }> = [{ value: "eligible", label: "Đủ điều kiện" }, { value: "monitoring", label: "Theo dõi" }, { value: "rejected", label: "Loại" }];
const STATUS_ORDER: Record<CandidateStatus, number> = { eligible: 0, monitoring: 1, rejected: 2 };
const ACCESSORS: Record<SortKey, (row: Candidate) => number | string | null> = {
  symbol: (row) => row.symbol, price: (row) => row.priceUsd ? Number(row.priceUsd) : null, launchpad: (row) => row.launchpad, migrated: (row) => row.migratedHours,
  risk: (row) => row.riskScore, bundle: (row) => row.bundlePct, cluster: (row) => row.clusterPct, liquidity: (row) => row.liquidityUsd, volume: (row) => row.volume1hUsd,
  status: (row) => STATUS_ORDER[row.status], tags: () => null,
};
const COLUMNS_KEY = "aegis-watchlist-columns", VIEWS_KEY = "aegis-watchlist-views";
// Column and view preferences are per-browser conveniences; any storage failure just falls back to defaults.
const load = <T,>(key: string, fallback: T): T => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

export function WatchlistTable({ candidates, archived, initialTag }: { candidates: Candidate[]; archived: boolean; initialTag: string | null }) {
  const { toast } = useFeedback();
  const [query, setQuery] = useState(""), [statuses, setStatuses] = useState<CandidateStatus[]>([]), [autoTradeOnly, setAutoTradeOnly] = useState(false), [pinnedOnly, setPinnedOnly] = useState(false);
  const [tag, setTag] = useState<string | null>(initialTag), [sort, setSort] = useState<SortState<SortKey>>(null);
  const [hidden, setHidden] = useState<WatchColumn[]>([]), [views, setViews] = useState<View[]>([]), [menu, setMenu] = useState<"columns" | "views" | null>(null);
  useEffect(() => { setHidden(load<WatchColumn[]>(COLUMNS_KEY, [])); setViews(load<View[]>(VIEWS_KEY, [])); }, []);

  const tags = useMemo(() => [...new Set(candidates.flatMap((item) => item.watch?.tags ?? []))].sort(), [candidates]);
  const columns = useMemo(() => new Set(COLUMNS.map((column) => column.key).filter((key) => !hidden.includes(key))), [hidden]);
  const rows = useMemo(() => sortRows(candidates.filter((item) => (statuses.length === 0 || statuses.includes(item.status)) && (!autoTradeOnly || item.watch?.autoTrade) && (!pinnedOnly || item.watch?.pinned) && (!tag || item.watch?.tags.includes(tag)) && matchesQuery(query, [item.symbol, item.name, item.mint, item.watch?.note, ...(item.watch?.tags ?? [])])), sort, ACCESSORS), [candidates, statuses, autoTradeOnly, pinnedOnly, tag, query, sort]);
  const filtered = query !== "" || statuses.length > 0 || autoTradeOnly || pinnedOnly || tag !== null;

  const toggleStatus = (status: CandidateStatus) => setStatuses((current) => current.includes(status) ? current.filter((item) => item !== status) : [...current, status]);
  const toggleColumn = (key: WatchColumn) => { const next = hidden.includes(key) ? hidden.filter((item) => item !== key) : [...hidden, key]; setHidden(next); save(COLUMNS_KEY, next); };
  const reset = () => { setQuery(""); setStatuses([]); setAutoTradeOnly(false); setPinnedOnly(false); setTag(null); setSort(null); };
  const applyView = (view: View) => { setQuery(view.query); setStatuses(view.statuses); setAutoTradeOnly(view.autoTradeOnly); setPinnedOnly(view.pinnedOnly); setTag(view.tag); setSort(view.sort); setMenu(null); };
  const [viewName, setViewName] = useState("");
  const saveView = (event: React.FormEvent) => {
    event.preventDefault();
    const name = viewName.trim();
    if (!name) return;
    setViewName("");
    const next = [...views.filter((view) => view.name !== name), { name, query, statuses, autoTradeOnly, pinnedOnly, tag, sort }].slice(-12);
    setViews(next); save(VIEWS_KEY, next); toast(`Đã lưu chế độ xem "${name}".`, "success");
  };
  const deleteView = (name: string) => { const next = views.filter((view) => view.name !== name); setViews(next); save(VIEWS_KEY, next); };
  const header = (key: SortKey, label: string, sortable = true) => sortable
    ? <th key={key} aria-sort={ariaSort(sort, key)}><button type="button" className={`sort-button${sort?.key === key ? " active" : ""}`} onClick={() => setSort(nextSort(sort, key))}>{label}<span aria-hidden="true">{sort?.key === key ? (sort.direction === "desc" ? " ↓" : " ↑") : " ↕"}</span></button></th>
    : <th key={key}>{label}</th>;

  return <>
    <div className="table-toolbar">
      <label className="table-search"><Search size={15} aria-hidden="true"/><span className="sr-only">Lọc watchlist</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Lọc theo symbol, tên, CA, ghi chú, tag…"/>{query && <button type="button" className="clear-button" aria-label="Xóa ô lọc" onClick={() => setQuery("")}><X size={14} aria-hidden="true"/></button>}</label>
      <div className="chip-row" role="group" aria-label="Lọc nhanh">
        {STATUSES.map((status) => <button key={status.value} type="button" className={`chip${statuses.includes(status.value) ? " active" : ""}`} aria-pressed={statuses.includes(status.value)} onClick={() => toggleStatus(status.value)}>{status.label}</button>)}
        <button type="button" className={`chip${autoTradeOnly ? " active" : ""}`} aria-pressed={autoTradeOnly} onClick={() => setAutoTradeOnly(!autoTradeOnly)}>AUTO</button>
        <button type="button" className={`chip${pinnedOnly ? " active" : ""}`} aria-pressed={pinnedOnly} onClick={() => setPinnedOnly(!pinnedOnly)}>Đã ghim</button>
        {tags.map((item) => <button key={item} type="button" className={`chip${tag === item ? " active" : ""}`} aria-pressed={tag === item} onClick={() => setTag(tag === item ? null : item)}>#{item}</button>)}
        {filtered && <button type="button" className="chip ghost" onClick={reset}>Xóa lọc</button>}
      </div>
      <div className="toolbar-menus">
        <div className="menu-anchor">
          <button type="button" className="ghost-button small" aria-expanded={menu === "views"} onClick={() => setMenu(menu === "views" ? null : "views")}><Bookmark size={14} aria-hidden="true"/> Chế độ xem</button>
          {menu === "views" && <div className="menu-popover" role="menu">
            {views.length === 0 && <p className="field-hint">Chưa có. Lọc/sắp xếp rồi đặt tên để lưu lại.</p>}
            {views.map((view) => <div key={view.name} className="menu-item-row"><button type="button" role="menuitem" className="menu-item" onClick={() => applyView(view)}>{view.name}</button><button type="button" className="clear-button" aria-label={`Xóa chế độ xem ${view.name}`} onClick={() => deleteView(view.name)}><X size={13} aria-hidden="true"/></button></div>)}
            <form className="menu-form" onSubmit={saveView}><label className="sr-only" htmlFor="view-name">Tên chế độ xem</label><input id="view-name" value={viewName} maxLength={30} onChange={(event) => setViewName(event.target.value)} placeholder={tag ? `#${tag}` : "Tên chế độ xem"}/><button type="submit" className="primary-button small" disabled={!viewName.trim()}>Lưu</button></form>
          </div>}
        </div>
        <div className="menu-anchor">
          <button type="button" className="ghost-button small" aria-expanded={menu === "columns"} onClick={() => setMenu(menu === "columns" ? null : "columns")}><Columns3 size={14} aria-hidden="true"/> Cột</button>
          {menu === "columns" && <div className="menu-popover" role="menu">{COLUMNS.map((column) => <label key={column.key} className="menu-check"><input type="checkbox" checked={columns.has(column.key)} onChange={() => toggleColumn(column.key)}/> {column.label}</label>)}</div>}
        </div>
      </div>
    </div>
    <div className="table-wrap"><table><thead><tr>{header("symbol", "Token")}{COLUMNS.filter((column) => columns.has(column.key)).map((column) => header(column.key, column.label, column.sortable))}<th><span className="sr-only">Thao tác</span></th></tr></thead>
      <tbody>{rows.length === 0 ? <tr><td colSpan={columns.size + 2}>{candidates.length === 0 ? (archived ? "Chưa có token nào được lưu trữ." : "Chưa có token. Hãy thêm CA hoặc bật Khám phá để bắt đầu.") : "Không có token khớp bộ lọc."}</td></tr> : rows.map((token) => <TokenRow key={token.mint} token={token} columns={columns}/>)}</tbody>
    </table></div>
    <p className="table-count">{rows.length === candidates.length ? `${candidates.length} token` : `${rows.length} / ${candidates.length} token`}</p>
  </>;
}
