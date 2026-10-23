"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, Crosshair, Eye, HeartPulse, ListOrdered, Pause, Plus, Radar, Search, Settings, Shield, ShoppingCart, Target, Wallet } from "lucide-react";
import { matchesQuery } from "@/lib/table-tools";
import { useFeedback } from "./feedback";

type SearchResult = {
  query: string; isAddress: boolean;
  tokens: Array<{ mint: string; symbol: string; name: string; status: string; archivedAt: string | null; pinned: boolean }>;
  discovered: Array<{ mint: string; symbol: string | null; name: string | null; migratedAt: string }>;
  positions: Array<{ id: string; mode: string; origin: string; mint: string; symbol: string }>;
  wallets: Array<{ address: string; label: string | null }>;
};
type Item = { id: string; group: string; title: string; detail: string; Icon: typeof Search; run: () => void | Promise<void> };

const PAGES = [
  { href: "/", label: "Watchlist", Icon: Crosshair }, { href: "/discovery", label: "Khám phá", Icon: Radar }, { href: "/orders", label: "Lệnh điều kiện", Icon: ListOrdered },
  { href: "/positions", label: "Vị thế", Icon: Wallet }, { href: "/performance", label: "Performance", Icon: Activity }, { href: "/wallets", label: "Ví theo dõi", Icon: Eye },
  { href: "/live-safety", label: "Live safety", Icon: Shield }, { href: "/settings", label: "Cài đặt", Icon: Settings }, { href: "/health", label: "System health", Icon: HeartPulse },
];
const STATUS_LABEL: Record<string, string> = { eligible: "đủ điều kiện", monitoring: "theo dõi", rejected: "loại" };
const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;
const ago = (iso: string) => { const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000); return minutes < 60 ? `${minutes} phút trước` : `${(minutes / 60).toFixed(1)} giờ trước`; };

async function post(url: string, body?: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as { message?: string; error?: string };
  if (!response.ok) throw new Error(data.error ?? "Thao tác thất bại.");
  return data.message;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useFeedback();
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(""), [result, setResult] = useState<SearchResult | null>(null), [active, setActive] = useState(0), [loading, setLoading] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) { element.showModal(); setQuery(""); setResult(null); setActive(0); setTimeout(() => input.current?.focus(), 0); }
    if (!open && element.open) element.close();
  }, [open]);

  // Debounced search; a newer keystroke aborts the previous request.
  useEffect(() => {
    if (!open || query.trim().length < 2) { setResult(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal }).then((response) => response.json() as Promise<SearchResult>).then(setResult).catch(() => undefined).finally(() => setLoading(false));
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, open]);

  const go = useCallback((href: string) => { onClose(); router.push(href); }, [onClose, router]);
  const act = useCallback((work: () => Promise<string | undefined>, success: string, href?: string) => async () => {
    onClose();
    try { toast((await work()) ?? success, "success"); if (href) router.push(href); router.refresh(); } catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); }
  }, [onClose, router, toast]);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [], trimmed = query.trim();
    if (result) {
      result.tokens.forEach((token) => list.push({ id: `t-${token.mint}`, group: "Token", title: token.symbol, detail: `${token.name} · ${token.archivedAt ? "đã lưu trữ" : `watchlist, ${STATUS_LABEL[token.status] ?? token.status}`} · ${short(token.mint)}`, Icon: Crosshair, run: () => go(`/tokens/${token.mint}`) }));
      const first = result.tokens.find((token) => !token.archivedAt);
      if (first) {
        list.push({ id: `buy-${first.mint}`, group: "Thao tác", title: `Mua / bán ${first.symbol}`, detail: "Mở panel giao dịch từ ví trình duyệt", Icon: ShoppingCart, run: () => go(`/tokens/${first.mint}#manual-trade`) });
        list.push({ id: `tp-${first.mint}`, group: "Thao tác", title: `Đặt TP/SL cho ${first.symbol}`, detail: "Lệnh điều kiện theo market cap", Icon: Target, run: () => go(`/tokens/${first.mint}#triggers`) });
      }
      result.positions.forEach((position) => list.push({ id: `p-${position.id}`, group: "Vị thế", title: position.symbol, detail: `Vị thế ${position.mode}${position.origin === "manual" ? " · thủ công" : ""} đang mở`, Icon: Wallet, run: () => go(`/tokens/${position.mint}`) }));
      result.discovered.forEach((token) => list.push({ id: `d-${token.mint}`, group: "Hộp khám phá", title: `Thêm ${token.symbol ?? short(token.mint)} vào watchlist`, detail: `Migrate ${ago(token.migratedAt)} · ${short(token.mint)}`, Icon: Radar, run: act(() => post(`/api/discovery/${token.mint}`), "Đã thêm vào watchlist.", `/tokens/${token.mint}`) }));
      result.wallets.forEach((wallet) => list.push({ id: `w-${wallet.address}`, group: "Ví theo dõi", title: wallet.label ?? short(wallet.address), detail: short(wallet.address), Icon: Eye, run: () => go(`/wallets/${wallet.address}`) }));
      if (result.isAddress && !result.tokens.some((token) => token.mint === trimmed)) {
        list.push({ id: "add-ca", group: "Địa chỉ đã dán", title: "Thêm CA này vào watchlist", detail: `Xác minh on-chain rồi lưu · ${short(trimmed)}`, Icon: Plus, run: act(() => post("/api/candidates", { mint: trimmed }), "Đã xác minh và thêm CA.", `/tokens/${trimmed}`) });
        if (!result.wallets.some((wallet) => wallet.address === trimmed)) list.push({ id: "track-wallet", group: "Địa chỉ đã dán", title: "Theo dõi địa chỉ này như một ví", detail: "Chỉ xem, không cần private key", Icon: Eye, run: act(() => post("/api/wallets", { address: trimmed, label: null }), "Đã thêm ví theo dõi.", `/wallets/${trimmed}`) });
      }
    }
    PAGES.filter((page) => matchesQuery(trimmed, [page.label])).forEach((page) => list.push({ id: `page-${page.href}`, group: "Đi tới", title: page.label, detail: page.href, Icon: page.Icon, run: () => go(page.href) }));
    if (matchesQuery(trimmed, ["pause entries tạm dừng vào lệnh"])) list.push({ id: "pause", group: "Hệ thống", title: "Pause entries", detail: "Dừng bot vào lệnh mới; thoát lệnh vẫn chạy", Icon: Pause, run: act(() => post("/api/settings/trading", { entriesPaused: true, reason: "Paused from command palette" }), "Đã pause entry.") });
    return list;
  }, [result, query, go, act]);

  useEffect(() => { setActive(0); }, [items.length]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(items.length - 1, index + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
    else if (event.key === "Enter" && items[active]) { event.preventDefault(); void items[active].run(); }
  };
  useEffect(() => { document.getElementById(`palette-${items[active]?.id}`)?.scrollIntoView({ block: "nearest" }); }, [active, items]);

  let lastGroup = "";
  return <dialog ref={dialog} className="command-palette" aria-label="Tìm kiếm nhanh" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
    <div className="palette-input"><Search size={18} aria-hidden="true"/><label htmlFor="palette-query" className="sr-only">Tìm kiếm</label>
      <input id="palette-query" ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Tìm token, dán CA hoặc địa chỉ ví, gõ tên trang…" role="combobox" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={items[active] ? `palette-${items[active].id}` : undefined} autoComplete="off" spellCheck={false}/>
      <kbd>Esc</kbd></div>
    <div id="palette-results" className="palette-results" role="listbox" aria-label="Kết quả">
      {query.trim().length >= 2 && !loading && result && items.every((item) => item.group === "Đi tới" || item.group === "Hệ thống") && <p className="palette-empty">Không tìm thấy token, vị thế hay ví khớp "{query.trim()}".</p>}
      {items.map((item, index) => { const heading = item.group !== lastGroup ? item.group : null; lastGroup = item.group; return <div key={item.id}>
        {heading && <div className="palette-group">{heading}</div>}
        <div id={`palette-${item.id}`} role="option" aria-selected={index === active} className={`palette-item${index === active ? " active" : ""}`} onMouseMove={() => setActive(index)} onClick={() => void item.run()}>
          <span className="palette-icon" aria-hidden="true"><item.Icon size={15}/></span><span className="palette-text"><strong>{item.title}</strong><small>{item.detail}</small></span>
        </div>
      </div>; })}
    </div>
    <div className="palette-footer"><span>↑↓ chọn</span><span>↵ mở</span><span>Dán CA để thêm mới</span>{loading && <span>Đang tìm…</span>}</div>
  </dialog>;
}
