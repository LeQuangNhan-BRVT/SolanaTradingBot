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

function McapField({ label, value, onChange, hint }: { label: string; value: string; onChange: (value: string) => void; hint?: string }) {
  const parsed = parseMcapInput(value);
  return <label>{label}<input value={value} onChange={(event) => onChange(event.target.value)} placeholder="ví dụ 2.5M, 750k" inputMode="decimal"/><small className="field-hint">{value ? parsed ? `= ${formatMcap(parsed)}` : "Không đọc được giá trị" : hint ?? ""}</small></label>;
}

export function TriggerForm({ mint, currentMcapUsd, hasPosition, eligible }: { mint: string; currentMcapUsd: number | null; hasPosition: boolean; eligible: boolean }) {
  const router = useRouter();
  const [type, setType] = useState<FormType>(hasPosition ? "bracket" : "limit_buy");
  const [mcap, setMcap] = useState(""), [tp, setTp] = useState(""), [sl, setSl] = useState(""), [buySol, setBuySol] = useState("0.05"), [sellPct, setSellPct] = useState("100"), [trailingPct, setTrailingPct] = useState("20"), [slippagePct, setSlippagePct] = useState("3"), [expiresInHours, setExpires] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null), [warnings, setWarnings] = useState<string[]>([]);
  const isSell = TYPES.find((item) => item.value === type)!.sell;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(null); setWarnings([]);
    const common = { mint, maxSlippageBps: Math.round(Number(slippagePct) * 100), expiresInHours: expiresInHours ? Number(expiresInHours) : null };
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
    <p className="field-hint">Market cap hiện tại: <strong>{formatMcap(currentMcapUsd)}</strong> · {hasPosition ? "đang có vị thế shadow" : "chưa có vị thế"}</p>
    <div className="watch-tabs">{TYPES.map((item) => { const disabled = item.sell ? !hasPosition : hasPosition; return <button type="button" key={item.value} className={`tab-button${type === item.value ? " active" : ""}`} disabled={disabled} title={disabled ? (item.sell ? "Cần vị thế đang mở" : "Token đã có vị thế") : ""} onClick={() => setType(item.value)}>{item.label}</button>; })}</div>
    {type === "limit_buy" && !eligible && <p className="form-message">⚠ Token chưa vượt hard gate (chưa eligible). Lệnh vẫn được phép theo cài đặt của bạn, nhưng rủi ro rất cao.</p>}
    <div className="watch-form-grid">
      {(type === "limit_buy" || type === "take_profit" || type === "stop_loss") && <McapField label={type === "limit_buy" ? "Mua khi mcap ≤" : type === "take_profit" ? "Bán khi mcap ≥" : "Bán khi mcap ≤"} value={mcap} onChange={setMcap}/>}
      {type === "bracket" && <><McapField label="Take profit khi mcap ≥" value={tp} onChange={setTp}/><McapField label="Stop loss khi mcap ≤" value={sl} onChange={setSl}/></>}
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
