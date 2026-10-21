"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Initial = { note: string | null; tags: string[]; autoTrade: boolean; alertPriceAboveUsd: string | null; alertPriceBelowUsd: string | null; alertChange1hPct: string | null; archived: boolean; status: string };
const clean = (value: string | null) => value === null ? "" : value.includes(".") ? value.replace(/\.?0+$/, "") : value;

export function WatchSettingsForm({ mint, initial }: { mint: string; initial: Initial }) {
  const router = useRouter();
  const [note, setNote] = useState(initial.note ?? ""), [tags, setTags] = useState(initial.tags.join(", ")), [autoTrade, setAutoTrade] = useState(initial.autoTrade);
  const [above, setAbove] = useState(clean(initial.alertPriceAboveUsd)), [below, setBelow] = useState(clean(initial.alertPriceBelowUsd)), [change, setChange] = useState(clean(initial.alertChange1hPct));
  const [saving, setSaving] = useState(false), [message, setMessage] = useState<string | null>(null);
  if (initial.archived) return <p className="empty-state">Token đã lưu trữ. Khôi phục từ tab Lưu trữ trong watchlist để chỉnh cài đặt.</p>;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setMessage(null);
    try {
      const response = await fetch(`/api/candidates/${mint}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: note.trim() || null, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), autoTrade, alertPriceAboveUsd: above.trim() || null, alertPriceBelowUsd: below.trim() || null, alertChange1hPct: change.trim() ? Number(change) : null }) });
      const data = await response.json() as { message?: string; error?: string };
      setMessage(data.message ?? data.error ?? null);
      if (response.ok) router.refresh();
    } catch { setMessage("Không thể kết nối máy chủ."); } finally { setSaving(false); }
  }
  return <form className="watch-form" onSubmit={submit}>
    <label>Ghi chú<textarea rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Lý do theo dõi, kế hoạch vào/ra lệnh…"/></label>
    <label>Tags (phân cách bằng dấu phẩy)<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="meme, đã-trade, chờ-dip"/></label>
    <div className="watch-form-grid">
      <label>Cảnh báo khi giá ≥ (USD)<input inputMode="decimal" value={above} onChange={(event) => setAbove(event.target.value)} placeholder="0.0015"/></label>
      <label>Cảnh báo khi giá ≤ (USD)<input inputMode="decimal" value={below} onChange={(event) => setBelow(event.target.value)} placeholder="0.0008"/></label>
      <label>Cảnh báo biến động 1h ≥ ±%<input inputMode="decimal" value={change} onChange={(event) => setChange(event.target.value)} placeholder="25"/></label>
    </div>
    <label className="watch-toggle"><input type="checkbox" checked={autoTrade} onChange={(event) => setAutoTrade(event.target.checked)}/> Cho phép bot tự vào lệnh (shadow/live) khi token đạt eligible</label>
    {autoTrade && initial.status !== "eligible" && <p className="field-hint">Token hiện chưa eligible; bot chỉ vào lệnh khi tất cả hard gate pass.</p>}
    <p className="field-hint">Cảnh báo được kiểm tra mỗi lần làm mới market (5 phút) và gửi qua Telegram/Webhook, tối đa 1 lần/giờ cho mỗi loại.</p>
    {message && <p className="form-message">{message}</p>}
    <div className="modal-actions"><button className="primary-button" disabled={saving} type="submit">{saving ? "Đang lưu…" : "Lưu cài đặt"}</button></div>
  </form>;
}
