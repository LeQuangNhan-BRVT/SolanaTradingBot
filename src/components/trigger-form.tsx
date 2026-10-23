"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatMcap, parseMcapInput } from "@/lib/triggers";

type FormType = "limit_buy" | "take_profit" | "stop_loss" | "trailing_stop" | "bracket";
const TYPES: Array<{ value: FormType; label: string; sell: boolean }> = [
  { value: "limit_buy", label: "Limit mua", sell: false },
  { value: "bracket", label: "TP + SL (OCO)", sell: true },
  { value: "take_profit", label: "Take profit", sell: true },
  { value: "stop_loss", label: "Stop loss", sell: true },
  { value: "trailing_stop", label: "Trailing stop", sell: true },
];

// Offsets are percentages of the current market cap, offered as one-click fills.
function McapField({ label, value, onChange, hint, base, offsets = [] }: { label: string; value: string; onChange: (value: string) => void; hint?: string; base?: number | null; offsets?: number[] }) {
  const parsed = parseMcapInput(value);
  return <div className="mcap-field"><label>{label}<input value={value} onChange={(event) => onChange(event.target.value)} placeholder="ví dụ 2.5M, 750k" inputMode="decimal"/><small className="field-hint">{value ? parsed ? `= ${formatMcap(parsed)}` : "Không đọc được giá trị" : hint ?? ""}</small></label>
    {base && offsets.length > 0 && <div className="pct-buttons" role="group" aria-label={`Gợi ý cho ${label}`}>{offsets.map((offset) => { const target = formatMcap(base * (1 + offset / 100)); return <button key={offset} type="button" className={`tab-button${value === target ? " active" : ""}`} aria-pressed={value === target} onClick={() => onChange(target)}>{offset > 0 ? "+" : "−"}{Math.abs(offset)}%</button>; })}</div>}
  </div>;
}

export type TriggerTarget = { id: string; label: string; mode: "shadow" | "live" };

export function TriggerForm({ mint, currentMcapUsd, targets, hasShadowPosition, eligible }: { mint: string; currentMcapUsd: number | null; targets: TriggerTarget[]; hasShadowPosition: boolean; eligible: boolean }) {
  const router = useRouter();
  const hasPosition = targets.length > 0;
  const [type, setType] = useState<FormType>(hasPosition ? "bracket" : "limit_buy");
  const [positionId, setPositionId] = useState(targets[0]?.id ?? "");
  const target = targets.find((item) => item.id === positionId);
  const [mcap, setMcap] = useState(""), [tp, setTp] = useState(""), [sl, setSl] = useState(""), [buySol, setBuySol] = useState("0.05"), [sellPct, setSellPct] = useState("100"), [trailingPct, setTrailingPct] = useState("20"), [slippagePct, setSlippagePct] = useState("3"), [expiresInHours, setExpires] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null), [warnings, setWarnings] = useState<string[]>([]);
  const isSell = TYPES.find((item) => item.value === type)!.sell;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(null); setWarnings([]);
    const common = { mint, ...(type !== "limit_buy" && positionId ? { positionId } : {}), maxSlippageBps: Math.round(Number(slippagePct) * 100), expiresInHours: expiresInHours ? Number(expiresInHours) : null };
    const body = type === "limit_buy" ? { ...common, type, triggerMcapUsd: parseMcapInput(mcap), buySol }
      : type === "bracket" ? { ...common, type, takeProfitMcapUsd: parseMcapInput(tp), stopLossMcapUsd: parseMcapInput(sl), sellPct: Number(sellPct) }
      : type === "trailing_stop" ? { ...common, type, trailingPct: Number(trailingPct), sellPct: Number(sellPct) }
      : { ...common, type, triggerMcapUsd: parseMcapInput(mcap), sellPct: Number(sellPct) };
    try {
      const response = await fetch("/api/triggers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { message?: string; error?: string; warnings?: string[] };
      setMessage(data.message ?? data.error ?? null); setWarnings(data.warnings ?? []);
      if (response.ok) { setMcap(""); setTp(""); setSl(""); router.refresh(); }
    } catch { setMessage("Không thể kết nối máy chủ."); } finally { setBusy(false); }
  }
  return <form className="watch-form trigger-form" onSubmit={submit}>
    <p className="field-hint">Market cap hiện tại: <strong>{formatMcap(currentMcapUsd)}</strong> · {hasPosition ? `${targets.length} vị thế đang mở` : "chưa có vị thế"}</p>
    <div className="watch-tabs">{TYPES.map((item) => { const disabled = item.sell ? !hasPosition : hasShadowPosition; return <button type="button" key={item.value} className={`tab-button${type === item.value ? " active" : ""}`} disabled={disabled} title={disabled ? (item.sell ? "Cần vị thế đang mở" : "Token đã có vị thế") : ""} onClick={() => setType(item.value)}>{item.label}</button>; })}</div>
    {isSell && targets.length > 0 && <label className="target-select">Áp dụng cho vị thế<select value={positionId} onChange={(event) => setPositionId(event.target.value)}>{targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
    {isSell && target?.mode === "live" && <p className="form-message">Vị thế ví trình duyệt: khi chạm ngưỡng app chỉ gửi cảnh báo và nút &quot;Bán ngay&quot; — bạn ký trên ví để bán.</p>}
    {type === "limit_buy" && !eligible && <p className="form-message">⚠ Token chưa vượt hard gate (chưa eligible). Lệnh vẫn được phép theo cài đặt của bạn, nhưng rủi ro rất cao.</p>}
    <div className="watch-form-grid">
      {(type === "limit_buy" || type === "take_profit" || type === "stop_loss") && <McapField label={type === "limit_buy" ? "Mua khi mcap ≤" : type === "take_profit" ? "Bán khi mcap ≥" : "Bán khi mcap ≤"} value={mcap} onChange={setMcap} base={currentMcapUsd} offsets={type === "take_profit" ? [25, 50, 100] : type === "stop_loss" ? [-15, -20, -30] : [-10, -20, -30]}/>}
      {type === "bracket" && <><McapField label="Take profit khi mcap ≥" value={tp} onChange={setTp} base={currentMcapUsd} offsets={[25, 50, 100]}/><McapField label="Stop loss khi mcap ≤" value={sl} onChange={setSl} base={currentMcapUsd} offsets={[-15, -20, -30]}/></>}
      {type === "trailing_stop" && <label>Bán khi giảm % từ đỉnh<input inputMode="decimal" value={trailingPct} onChange={(event) => setTrailingPct(event.target.value)}/></label>}
      {type === "limit_buy" && <label>Số SOL mua<input inputMode="decimal" value={buySol} onChange={(event) => setBuySol(event.target.value)}/></label>}
      {isSell && <label>% vị thế bán<input inputMode="decimal" value={sellPct} onChange={(event) => setSellPct(event.target.value)}/></label>}
      <label>Price impact tối đa (%)<input inputMode="decimal" value={slippagePct} onChange={(event) => setSlippagePct(event.target.value)}/></label>
      <label>Hết hạn sau (giờ, để trống = không)<input inputMode="decimal" value={expiresInHours} onChange={(event) => setExpires(event.target.value)}/></label>
    </div>
    <p className="field-hint">Giá được theo dõi mỗi ~5 giây và xác nhận bằng quote Jupiter trước khi khớp. Limit chỉ khớp ở giá đặt hoặc tốt hơn; stop khớp theo thị trường nhưng bị chặn nếu price impact vượt giới hạn — khi đó lệnh có thể không khớp. Chế độ shadow: không dùng tiền thật.</p>
    {message && <p className="form-message">{message}</p>}
    {warnings.map((warning) => <p key={warning} className="form-message">⚠ {warning}</p>)}
    <div className="modal-actions"><button className="primary-button" disabled={busy || currentMcapUsd === null} type="submit">{busy ? "Đang tạo…" : "Tạo lệnh"}</button></div>
  </form>;
}
