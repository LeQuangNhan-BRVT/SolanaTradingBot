"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { FILTER_FIELDS, describeRule, type FilterField, type MetricValue, type RuleResult } from "@/lib/filter-rules";
import { formatMcap } from "@/lib/triggers";

type Settings = { enabled: boolean; retentionHours: number; recheckMinutes: number; heliusDailyCredits: number };

export function DiscoverySettingsForm({ initial }: { initial: Settings }) {
  const router = useRouter();
  const [values, setValues] = useState({ ...initial, retentionHours: String(initial.retentionHours), recheckMinutes: String(initial.recheckMinutes), heliusDailyCredits: String(initial.heliusDailyCredits) });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  async function save(next = values) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/discovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: next.enabled, retentionHours: Number(next.retentionHours), recheckMinutes: Number(next.recheckMinutes), heliusDailyCredits: Number(next.heliusDailyCredits) }) });
      const data = await response.json() as { message?: string; error?: string };
      setMessage(data.message ?? data.error ?? null);
      if (response.ok) router.refresh();
    } catch { setMessage("Không thể kết nối máy chủ."); } finally { setBusy(false); }
  }
  return <form className="watch-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label className="watch-toggle"><input type="checkbox" checked={values.enabled} onChange={(event) => { const next = { ...values, enabled: event.target.checked }; setValues(next); void save(next); }}/> Tự động phát hiện token migrate từ Pump.fun (worker chạy mỗi phút)</label>
    <div className="watch-form-grid">
      <label>Giữ token chưa rõ tối đa (giờ)<input inputMode="numeric" value={values.retentionHours} onChange={(event) => setValues({ ...values, retentionHours: event.target.value })}/></label>
      <label>Lọc lại mỗi (phút)<input inputMode="numeric" value={values.recheckMinutes} onChange={(event) => setValues({ ...values, recheckMinutes: event.target.value })}/></label>
      <label>Trần credit Helius/ngày<input inputMode="numeric" value={values.heliusDailyCredits} onChange={(event) => setValues({ ...values, heliusDailyCredits: event.target.value })}/></label>
    </div>
    {message && <p className="form-message">{message}</p>}
    <div className="modal-actions"><button className="primary-button" disabled={busy} type="submit">Lưu cài đặt</button></div>
  </form>;
}

export type DiscoveredRow = { mint: string; symbol: string | null; name: string | null; status: string; migratedAt: string; metrics: Record<string, MetricValue | string | number>; evaluation: Array<{ presetId: string; name: string; outcome: "pass" | "fail" | "unknown"; results: RuleResult[] }>; lastError: string | null };

const ago = (iso: string) => { const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000)); return minutes < 60 ? `${minutes} phút` : minutes < 1_440 ? `${(minutes / 60).toFixed(1)} giờ` : `${(minutes / 1_440).toFixed(1)} ngày`; };
function metric(value: MetricValue | string | number | undefined, suffix = "") {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return `≥ ${value.lowerBound.toFixed(2)}${suffix}`;
  if (typeof value === "number") return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}${suffix}`;
  return String(value);
}
const usd = (value: unknown) => typeof value === "number" ? `$${value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value.toFixed(0)}` : "—";
const OUTCOME = { pass: "Đạt", fail: "Trượt", unknown: "Chưa rõ" } as const;

function explain(results: RuleResult[]) {
  return results.map((result) => `${result.outcome === "pass" ? "✓" : result.outcome === "fail" ? "✕" : "?"} ${describeRule(result)} — thực tế: ${metric(result.actual as MetricValue)}`).join("\n");
}

export function DiscoveryTable({ rows }: { rows: DiscoveredRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  async function promote(mint: string) {
    setBusy(mint);
    try { const response = await fetch(`/api/discovery/${mint}`, { method: "POST" }); const data = await response.json() as { message?: string; error?: string }; if (!response.ok) window.alert(data.error ?? "Không thể thêm."); router.refresh(); } finally { setBusy(null); }
  }
  if (rows.length === 0) return <p className="empty-state wallet-hint">Chưa có token. Bật tự động phát hiện để worker bắt đầu theo dõi các lần migrate mới.</p>;
  return <div className="table-wrap"><table className="compact-table discovery-table"><thead><tr><th>Token</th><th>Migrate</th><th>Mcap</th><th>Volume 24h</th><th>Liquidity</th><th>{FILTER_FIELDS.top10Pct.label}</th><th>Bundle</th><th>Fees (SOL)</th><th>Nhãn</th><th>Preset</th><th></th></tr></thead><tbody>{rows.map((row) => {
    const m = row.metrics;
    return <tr key={row.mint}>
      <td><strong>{row.symbol ?? "?"}</strong> <a className="external" href={`https://dexscreener.com/solana/${row.mint}`} target="_blank" rel="noreferrer">{row.mint.slice(0, 4)}…{row.mint.slice(-4)} <ExternalLink size={10}/></a></td>
      <td>{ago(row.migratedAt)}</td><td>{formatMcap(typeof m.mcapUsd === "number" ? m.mcapUsd : null)}</td><td>{usd(m.volume24hUsd)}</td><td>{usd(m.liquidityUsd)}</td>
      <td>{metric(m.top10Pct as MetricValue, "%")}</td><td>{metric(m.bundlePct as MetricValue, "%")}</td><td>{metric(m.totalFeesSol as MetricValue)}</td>
      <td>{m.dexPaid === true && <span className="tag auto">DEX PAID</span>}{m.cto === true && <span className="tag">CTO</span>}</td>
      <td>{row.evaluation.map((item) => <span key={item.presetId} className={`outcome ${item.outcome}`} title={explain(item.results)}>{item.name}: {OUTCOME[item.outcome]}</span>)}{row.lastError && <small className="field-hint" title={row.lastError}> · lỗi</small>}</td>
      <td>{row.status === "promoted" ? <Link href={`/tokens/${row.mint}`}>Trong watchlist →</Link> : <button className="ghost-button small" disabled={busy === row.mint} onClick={() => void promote(row.mint)}>{busy === row.mint ? "Đang thêm…" : "+ Watchlist"}</button>}</td>
    </tr>;
  })}</tbody></table></div>;
}

export const FIELD_LABEL = (field: FilterField) => FILTER_FIELDS[field].label;
