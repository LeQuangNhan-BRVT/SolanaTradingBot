"use client";
import { useFeedback } from "./feedback";
import { useTradeDrawer } from "./trade-drawer";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Pin, PinOff } from "lucide-react";

async function send(url: string, method: string, body: unknown) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Không thể cập nhật watchlist.");
}

export function WatchActions({ mint, symbol, pinned, archived }: { mint: string; symbol: string; pinned: boolean; archived: boolean }) {
  const router = useRouter();
  const { toast, confirm } = useFeedback();
  const { openTrade } = useTradeDrawer();
  const [busy, setBusy] = useState(false);
  const run = async (event: React.MouseEvent, action: () => Promise<void>) => {
    event.stopPropagation();
    setBusy(true);
    try { await action(); router.refresh(); } catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); }
  };
  const stop = (event: React.KeyboardEvent) => event.stopPropagation();
  if (archived) return <div className="watch-actions" onKeyDown={stop}><button className="icon-button" disabled={busy} title="Khôi phục (xác minh lại CA)" aria-label={`Khôi phục ${symbol}`} onClick={(event) => run(event, () => send("/api/candidates", "POST", { mint }))}><ArchiveRestore size={15}/></button></div>;
  return <div className="watch-actions" onKeyDown={stop}>
    <button className="ghost-button row-trade" title="Mua / bán nhanh từ ví" aria-label={`Giao dịch ${symbol}`} onClick={(event) => { event.stopPropagation(); openTrade(mint); }}>Giao dịch</button>
    <button className={`icon-button${pinned ? " active" : ""}`} disabled={busy} title={pinned ? "Bỏ ghim" : "Ghim lên đầu"} aria-label={pinned ? `Bỏ ghim ${symbol}` : `Ghim ${symbol}`} onClick={(event) => run(event, () => send(`/api/candidates/${mint}`, "PATCH", { pinned: !pinned }))}>{pinned ? <PinOff size={15}/> : <Pin size={15}/>}</button>
    <button className="icon-button" disabled={busy} title="Lưu trữ và dừng cập nhật nền" aria-label={`Lưu trữ ${symbol}`} onClick={(event) => run(event, async () => { if (await confirm({ title: `Lưu trữ ${symbol}?`, message: "Bot sẽ ngừng cập nhật và không tự giao dịch token này. Khôi phục được từ tab Lưu trữ.", confirmLabel: "Lưu trữ" })) { await send(`/api/candidates/${mint}`, "PATCH", { archived: true }); toast(`Đã lưu trữ ${symbol}.`, "success"); } })}><Archive size={15}/></button>
  </div>;
}

export function AddToWatchlistButton({ mint }: { mint: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  return <span className="watch-add"><button className="ghost-button small" disabled={state !== "idle"} onClick={async () => { setState("busy"); setError(null); try { await send("/api/candidates", "POST", { mint }); setState("done"); router.refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setState("idle"); } }}>{state === "busy" ? "Đang xác minh…" : state === "done" ? "Đã thêm" : "+ Watchlist"}</button>{error && <small className="negative">{error}</small>}</span>;
}
