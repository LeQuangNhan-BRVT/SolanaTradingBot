import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getDiscoverySettings, getDiscoveryStats, getRuntimeValue, listDiscoveredTokens, listFilterPresets } from "@/db/repository";
import { DiscoverySettingsForm, DiscoveryTable, type DiscoveredRow } from "@/components/discovery-controls";
import { PresetEditor, type PresetRow } from "@/components/preset-editor";
import { DEFAULT_PRESET, filterGroupSchema } from "@/lib/filter-rules";
import { heliusCreditsUsedToday } from "@/queue/client";
export const dynamic = "force-dynamic";

export default async function DiscoveryPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const status = view === "promoted" ? "promoted" : view === "all" ? undefined : "pending";
  const [settings, stats, presetsRaw, tokens, cursor, creditsUsed] = await Promise.all([getDiscoverySettings(), getDiscoveryStats(), listFilterPresets(), listDiscoveredTokens({ status, limit: 200 }), getRuntimeValue<{ polledAt?: string }>("discovery-cursor"), heliusCreditsUsedToday().catch(() => null)]);
  // Before the worker has seeded it, show the default preset so the editor starts from the user's prefilter.
  const presets: PresetRow[] = presetsRaw.length ? presetsRaw.flatMap((row) => { const parsed = filterGroupSchema.safeParse(row.rules); return parsed.success ? [{ id: row.id, name: row.name, rules: parsed.data, enabled: row.enabled, autoPromote: row.autoPromote }] : []; }) : [{ id: "", name: DEFAULT_PRESET.name, rules: DEFAULT_PRESET.rules, enabled: true, autoPromote: true }];
  const rows: DiscoveredRow[] = tokens.map((token) => ({ mint: token.mint, symbol: token.symbol, name: token.name, status: token.status, migratedAt: token.migratedAt.toISOString(), metrics: token.metrics as DiscoveredRow["metrics"], evaluation: token.evaluation as unknown as DiscoveredRow["evaluation"], lastError: token.lastError }));
  return <main className="positions-shell"><header className="detail-top"><Link href="/"><ArrowLeft size={16}/> Tổng quan</Link><span className={`mode-pill${settings.enabled ? "" : " paused"}`}>{settings.enabled ? "DISCOVERY ON" : "DISCOVERY OFF"}</span></header><div className="positions-content">
    <div className="page-title"><div><span className="eyebrow">MIGRATION DISCOVERY</span><h1>Hộp khám phá</h1><p>Mọi token migrate từ Pump.fun sang PumpSwap được ghi vào đây; token đạt preset tự vào watchlist (auto-trade tắt) và được xác minh sâu.</p></div></div>
    <section className="position-metrics">
      <article><span>Migrate 24h qua</span><strong>{stats.last24h}</strong></article>
      <article><span>Đang chờ lọc</span><strong>{stats.pending}</strong></article>
      <article><span>Đã vào watchlist</span><strong>{stats.promoted}</strong></article>
      <article><span>Credit Helius hôm nay</span><strong>{creditsUsed === null ? "—" : creditsUsed.toLocaleString("vi-VN")}</strong><small className="field-hint">Trần {settings.heliusDailyCredits.toLocaleString("vi-VN")} · quét lần cuối {cursor?.polledAt ? new Date(cursor.polledAt).toLocaleTimeString("vi-VN") : "—"}</small></article>
    </section>
    <section className="detail-card watch-card"><span className="eyebrow">SETTINGS</span><h2>Cài đặt khám phá</h2><DiscoverySettingsForm initial={settings}/></section>
    <section className="detail-card watch-card"><span className="eyebrow">PRESETS</span><h2>Bộ lọc linh hoạt</h2><PresetEditor presets={presets}/></section>
    <section className="panel"><div className="panel-head"><div><span className="eyebrow">INBOX</span><h2>Token đã migrate</h2></div><div className="watch-tabs"><a className={!view ? "active" : ""} href="/discovery">Đang chờ</a><a className={view === "promoted" ? "active" : ""} href="/discovery?view=promoted">Đã vào watchlist</a><a className={view === "all" ? "active" : ""} href="/discovery?view=all">Tất cả</a></div></div><DiscoveryTable rows={rows}/><p className="field-hint wallet-hint">Di chuột lên kết quả preset để xem từng quy tắc đạt/trượt và số đo thực tế. "Chưa rõ" nghĩa là còn thiếu dữ liệu; token sẽ được lọc lại ở chu kỳ sau.</p></section>
  </div></main>;
}
