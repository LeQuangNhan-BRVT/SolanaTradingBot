"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { ManualTradePanel, type WalletAlert, type WalletPosition } from "./manual-trade-panel";

type TradeContext = { mint: string; symbol: string; name: string; decimals: number | null; enabled: boolean; disabledReason: string | null; halted: boolean; positions: WalletPosition[]; alerts: WalletAlert[] };
type DrawerApi = { openTrade: (mint: string) => void };
const DrawerContext = createContext<DrawerApi | null>(null);

// Quick-trade drawer: trade any watchlist token from a list row without leaving the page.
export function TradeDrawerProvider({ children }: { children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mint, setMint] = useState<string | null>(null), [data, setData] = useState<TradeContext | null>(null), [error, setError] = useState<string | null>(null);
  const openTrade = useCallback((next: string) => { setMint(next); setData(null); setError(null); }, []);
  const close = useCallback(() => { dialog.current?.close(); setMint(null); }, []);

  useEffect(() => {
    if (!mint) return;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    const controller = new AbortController();
    fetch(`/api/tokens/${mint}/trade-context`, { signal: controller.signal })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Không tải được dữ liệu giao dịch."); setData(body as TradeContext); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [mint]);

  return <DrawerContext.Provider value={{ openTrade }}>
    {children}
    <dialog ref={dialog} className="trade-drawer" aria-labelledby="trade-drawer-title" onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === dialog.current) close(); }}>
      <div className="drawer-head">
        <div><span className="eyebrow">GIAO DỊCH NHANH · VÍ TRÌNH DUYỆT</span><h2 id="trade-drawer-title">{data ? `${data.symbol}` : "Đang tải…"}</h2>{data && <small className="field-hint">{data.name}</small>}</div>
        <button type="button" className="icon-button" aria-label="Đóng ngăn giao dịch" onClick={close}><X size={16} aria-hidden="true"/></button>
      </div>
      <div className="drawer-body">
        {error && <p className="form-message">{error}</p>}
        {data && <ManualTradePanel key={data.mint} mint={data.mint} symbol={data.symbol} decimals={data.decimals} enabled={data.enabled} disabledReason={data.disabledReason} halted={data.halted} prefillSellPct={null} positions={data.positions} alerts={data.alerts}/>}
        {data && <Link className="external drawer-link" href={`/tokens/${data.mint}`} onClick={close}>Mở trang token đầy đủ →</Link>}
      </div>
    </dialog>
  </DrawerContext.Provider>;
}

export function useTradeDrawer() {
  const context = useContext(DrawerContext);
  if (!context) throw new Error("useTradeDrawer must be used inside TradeDrawerProvider.");
  return context;
}
