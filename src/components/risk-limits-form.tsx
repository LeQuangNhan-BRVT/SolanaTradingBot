"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RiskLimits } from "@/lib/risk-engine";

const FIELDS: Array<{ key: keyof RiskLimits; label: string; hint: string }> = [
  { key: "minimumMigrationHours", label: "Tuổi migration tối thiểu (giờ)", hint: "0–168" },
  { key: "minimumLiquidityUsd", label: "Thanh khoản tối thiểu (USD)", hint: "1.000–10.000.000" },
  { key: "maximumCreatorClusterPct", label: "Creator cluster tối đa (%)", hint: "0–50" },
  { key: "maximumSuspectedBundlePct", label: "Bundle nghi vấn tối đa (%)", hint: "0–80" },
];

export function RiskLimitsForm({ initial, defaults }: { initial: RiskLimits; defaults: RiskLimits }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<keyof RiskLimits, string>>(Object.fromEntries(FIELDS.map(({ key }) => [key, String(initial[key])])) as Record<keyof RiskLimits, string>);
  const [saving, setSaving] = useState(false), [message, setMessage] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setMessage(null);
    try {
      const body = Object.fromEntries(FIELDS.map(({ key }) => [key, Number(values[key])]));
      const response = await fetch("/api/settings/risk-limits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { message?: string; error?: string };
      setMessage(data.message ?? data.error ?? null);
      if (response.ok) router.refresh();
    } catch { setMessage("Không thể kết nối máy chủ."); } finally { setSaving(false); }
  }
  return <form className="watch-form risk-limits-form" onSubmit={submit}>
    <div className="watch-form-grid">{FIELDS.map(({ key, label, hint }) => <label key={key}>{label}<input inputMode="decimal" value={values[key]} onChange={(event) => setValues({ ...values, [key]: event.target.value })}/><small className="field-hint">{hint} · mặc định {defaults[key].toLocaleString("vi-VN")}</small></label>)}</div>
    <p className="field-hint">Mint authority và freeze authority luôn phải bị vô hiệu hóa, không chỉnh được. Dữ liệu chưa xác minh luôn chặn giao dịch, dù ngưỡng nới đến đâu.</p>
    {message && <p className="form-message">{message}</p>}
    <div className="modal-actions"><button className="primary-button" disabled={saving} type="submit">{saving ? "Đang lưu…" : "Lưu hard gate"}</button></div>
  </form>;
}
