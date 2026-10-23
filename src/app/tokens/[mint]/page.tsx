import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Shield } from "lucide-react";
import { getCandidateDetail, getDiscoveredToken, getTradingControls, getTriggerContext, listTokenOrders, listTriggerOrders } from "@/db/repository";
import { ManualTradePanel } from "@/components/manual-trade-panel";
import { manualTradingConfigError } from "@/lib/manual-trading";
import { formatUnits } from "@/lib/wallet-tracker";
import { TriggerForm } from "@/components/trigger-form";
import { TriggerList, type TriggerRow } from "@/components/trigger-list";
import { formatMcap, mcapFromPrice } from "@/lib/triggers";
import { WatchSettingsForm } from "@/components/watch-settings-form";
import { CopyText, Tabs } from "@/components/token-tabs";
import { BubbleMap, DexScreenerChart } from "@/components/token-embeds";
export const dynamic = "force-dynamic";

const short = (v: string | null | undefined) => v ? `${v.slice(0, 6)}…${v.slice(-5)}` : "—";
const pct = (v: string | number | null | undefined) => v == null ? "—" : `${Number(v).toFixed(2)}%`;
const sol = (v: string) => `${(Number(v) / 1e9).toFixed(4)} SOL`;
const price = (v: string | null | undefined) => v ? `$${Number(v).toPrecision(4)}` : "—";
const ORDER_STATUS: Record<string, string> = { created: "Đã tạo", quoted: "Đã quote", simulated: "Đã mô phỏng", submitted: "Đã gửi", confirmed: "Đã khớp", failed: "Thất bại", cancelled: "Đã hủy" };
const CHECK_ICON = { pass: "✓", fail: "✕", unknown: "?" } as const;

export default async function TokenDetail({ params, searchParams }: { params: Promise<{ mint: string }>; searchParams: Promise<{ sell?: string }> }) {
  const { mint } = await params, { sell } = await searchParams;
  const [d, ctx, triggers, controls, orderRows, discovered] = await Promise.all([getCandidateDetail(mint), getTriggerContext(mint), listTriggerOrders({ mint }), getTradingControls(), listTokenOrders(mint), getDiscoveredToken(mint)]);
  if (!d) notFound();
  const { token } = d;
  const manualError = manualTradingConfigError(), prefillSell = sell && Number(sell) > 0 && Number(sell) <= 100 ? Number(sell) : null;
  const walletPositions = ctx?.walletPositions ?? [];
  const fmtQty = (raw: string) => token.decimals === null ? raw : formatUnits(raw, token.decimals);
  const targets = [
    ...(ctx?.position ? [{ id: ctx.position.id, label: `Shadow · ${fmtQty(ctx.position.quantityRaw)} ${token.symbol}`, mode: "shadow" as const }] : []),
    ...walletPositions.map((p) => ({ id: p.id, label: `Ví ${p.wallet ? `${p.wallet.slice(0, 4)}…${p.wallet.slice(-4)}` : "?"} · ${fmtQty(p.quantityRaw)} ${token.symbol}`, mode: "live" as const })),
  ];
  const walletAlerts = triggers.filter((t) => t.mode === "live" && t.status === "triggered").map((t) => ({ id: t.id, type: t.type, sellPctBps: t.sellPctBps }));
  const currentMcap = ctx?.priceUsd && token.supplyRaw && token.decimals !== null ? mcapFromPrice(Number(ctx.priceUsd), token.supplyRaw, token.decimals) : null;
  const triggerRows: TriggerRow[] = triggers.map((t) => ({ ...t, expiresAt: t.expiresAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString(), filledAt: t.filledAt?.toISOString() ?? null }));
  const external = d.holders.filter((h) => !h.excluded).slice(0, 10);
  const top10 = external.length ? external.reduce((sum, h) => sum + Number(h.percentage ?? 0), 0) : null;
  const flags = discovered?.metrics ?? {};
  const change = d.pool?.priceChange1h == null ? null : Number(d.pool.priceChange1h);
  const checks = d.risk?.checks ?? [];

  const stats: Array<{ label: string; value: React.ReactNode; tone?: string }> = [
    { label: "Giá", value: price(d.pool?.priceUsd) },
    { label: "Market cap", value: formatMcap(currentMcap) },
    { label: "Volume 24h", value: formatMcap(d.pool?.volume24hUsd) },
    { label: "Liquidity", value: formatMcap(d.pool?.liquidityUsd) },
    { label: "1h", value: change === null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`, tone: change === null ? undefined : change >= 0 ? "positive" : "negative" },
    { label: "Top 10", value: pct(top10), tone: top10 !== null && top10 >= 30 ? "negative" : undefined },
    { label: "Bundle", value: pct(d.risk?.suspectedBundlePct) },
    { label: "Risk", value: `${token.riskScore}/100`, tone: token.riskScore >= 60 ? "negative" : token.riskScore >= 30 ? "warn" : "positive" },
  ];

  const overview = <div className="token-overview">
    <DexScreenerChart pairAddress={d.pool?.address ?? null} mint={token.mint}/>
    <div className="detail-grid">
      <article className="detail-card"><span className="eyebrow">HARD GATE</span><h2>Kiểm tra an toàn</h2>
        {!checks.length ? <p className="empty-state">Chưa có đánh giá rủi ro.</p> : <ul className="gate-list">{checks.map((check) => <li key={check.code} className={check.status}><b aria-label={check.status}>{CHECK_ICON[check.status]}</b><div><strong>{check.label}</strong><span>{check.detail}</span></div></li>)}</ul>}
      </article>
      <article className="detail-card"><span className="eyebrow">ON-CHAIN ORIGIN</span><h2>Migration & creator</h2><dl>
        <div><dt>Creator</dt><dd><code>{short(d.creator?.address)}</code></dd></div>
        <div><dt>Migration</dt><dd>{d.migration?.blockTime.toLocaleString("vi-VN") ?? "—"}</dd></div>
        <div><dt>Pool</dt><dd><code>{short(d.pool?.address)}</code></dd></div>
        <div><dt>Creator cluster</dt><dd>{pct(d.risk?.creatorClusterPct)}</dd></div>
      </dl></article>
    </div>
  </div>;

  const holders = !d.holders.length ? <p className="empty-state">Chưa có snapshot holder.</p> : <div className="table-wrap compact-table"><table><thead><tr><th>#</th><th>Owner</th><th>Tỷ lệ</th><th>Phân loại</th><th>Direct funder</th><th>Funding</th></tr></thead><tbody>
    {d.holders.map((h) => <tr key={h.tokenAccount}><td>{h.rank}</td><td><code>{short(h.owner)}</code></td><td>{pct(h.percentage)}</td><td>{h.excluded ? h.exclusionReason ?? "Excluded" : "External holder"}</td><td><code>{short(h.funding?.from)}</code></td><td>{h.funding ? sol(h.funding.lamports) : "—"}</td></tr>)}
  </tbody></table></div>;

  // Bundle evidence exists only for CAs added by hand (full analysis); watchlist tokens rely on the Bubblemaps holder map.
  const map = <div className="token-map">
    <BubbleMap mint={token.mint}/>
    {d.bundle && <article className="detail-card"><span className="eyebrow">BUNDLE EVIDENCE · {d.bundle.coveredTransactions} TX{d.bundle.truncated ? " · CHƯA QUÉT HẾT" : ""}</span><h2>Bằng chứng bundle</h2>
      {!d.bundle.evidence.length ? <p className="empty-state">Không tìm thấy bằng chứng bundle trong phạm vi đã quét.</p> : <div className="evidence-list">{d.bundle.evidence.map((item, index) => <div key={index}><strong>{String(item.code)} · +{String(item.weight)}</strong><span>{String(item.detail)}</span></div>)}</div>}
    </article>}
  </div>;

  const history = <div className="token-history">
    {!orderRows.length ? <p className="empty-state">Chưa có lệnh nào cho token này.</p> : <div className="table-wrap compact-table"><table><thead><tr><th>Thời gian</th><th>Loại</th><th>Chiều</th><th>Trạng thái</th><th>Khớp</th><th>Phí</th><th>Tx</th></tr></thead><tbody>
      {orderRows.map((o) => <tr key={o.id}>
        <td>{o.createdAt.toLocaleString("vi-VN")}</td>
        <td>{o.mode}{o.origin === "manual" ? " · ví" : ""}</td>
        <td className={o.side === "buy" ? "positive" : "negative"}>{o.side === "buy" ? "Mua" : "Bán"}</td>
        <td><span className={`order-status ${o.status}`}>{ORDER_STATUS[o.status] ?? o.status}</span>{o.error && <small className="field-hint order-error">{o.error}</small>}</td>
        <td>{o.fillTokenRaw ? `${fmtQty(o.fillTokenRaw)} ${token.symbol} · ${sol(o.fillLamports ?? "0")}` : "—"}</td>
        <td>{o.feeLamports ? sol(o.feeLamports) : "—"}</td>
        <td>{o.signature ? <a className="external" href={`https://solscan.io/tx/${o.signature}`} target="_blank" rel="noreferrer">{short(o.signature)} <ExternalLink size={11} aria-hidden="true"/></a> : "—"}</td>
      </tr>)}
    </tbody></table></div>}
    <h3 className="subhead">Lệnh điều kiện</h3>
    <TriggerList rows={triggerRows}/>
  </div>;

  const trade = <ManualTradePanel mint={token.mint} symbol={token.symbol} decimals={token.decimals} enabled={!manualError} disabledReason={manualError} halted={controls.haltAll} prefillSellPct={prefillSell} positions={walletPositions.map((p) => ({ wallet: p.wallet, quantityRaw: p.quantityRaw, costLamports: p.costLamports }))} alerts={walletAlerts}/>;
  const triggerForm = token.archivedAt ? <p className="empty-state">Token đã lưu trữ.</p> : <TriggerForm mint={token.mint} currentMcapUsd={currentMcap} targets={targets} hasShadowPosition={Boolean(ctx?.position)} eligible={token.status === "eligible"}/>;
  const watch = <WatchSettingsForm mint={token.mint} initial={{ note: token.watchNote, tags: token.watchTags, autoTrade: token.autoTrade, alertPriceAboveUsd: token.alertPriceAboveUsd, alertPriceBelowUsd: token.alertPriceBelowUsd, alertChange1hPct: token.alertChange1hPct, archived: token.archivedAt !== null, status: token.status }}/>;

  return <main className="token-page">
    <nav className="breadcrumb" aria-label="Breadcrumb"><Link href="/">Watchlist</Link><span aria-hidden="true">/</span><span aria-current="page">{token.symbol}</span></nav>
    <header className="token-head">
      <div className="token-head-main">
        <div className="token-logo large" aria-hidden="true">{token.symbol.slice(0, 2).toUpperCase()}</div>
        <div>
          <h1>{token.symbol} <small>{token.name}</small></h1>
          <CopyText value={token.mint} label="Sao chép địa chỉ mint"/>
        </div>
      </div>
      <div className="token-head-side">
        <span className={`status ${token.status}`}>{token.status}</span>
        {token.archivedAt && <span className="head-tag">Đã lưu trữ</span>}
        {flags.dexPaid === true && <span className="head-tag info">DEX PAID</span>}
        {flags.cto === true && <span className="head-tag info">CTO</span>}
        {token.watchTags.map((tag) => <span key={tag} className="head-tag">#{tag}</span>)}
        <a className="external" href={`https://dexscreener.com/solana/${token.mint}`} target="_blank" rel="noreferrer">DexScreener <ExternalLink size={11} aria-hidden="true"/></a>
        <a className="external" href={`https://solscan.io/token/${token.mint}`} target="_blank" rel="noreferrer">Solscan <ExternalLink size={11} aria-hidden="true"/></a>
      </div>
    </header>
    <section className="token-stats" aria-label="Chỉ số chính">
      {stats.map((stat) => <div key={stat.label}><span>{stat.label}</span><strong className={stat.tone ?? ""}>{stat.value}</strong></div>)}
    </section>
    <div className="token-layout">
      <section className="token-main panel-card">
        <Tabs label="Thông tin token" tabs={[
          { id: "overview", label: "Tổng quan", content: overview },
          { id: "holders", label: `Holder (${d.holders.length})`, content: holders },
          { id: "map", label: "Bản đồ (Bubblemaps)", content: map },
          { id: "history", label: `Lịch sử lệnh (${orderRows.length})`, content: history },
        ]}/>
      </section>
      <aside className="token-side panel-card">
        <Tabs label="Giao dịch" tabs={[
          { id: "manual-trade", label: "Ví", content: <><p className="eyebrow">VÍ TRÌNH DUYỆT · TIỀN THẬT</p>{trade}</> },
          { id: "triggers", label: "Lệnh chờ", content: <><p className="eyebrow">THEO MARKET CAP</p>{triggerForm}</> },
          { id: "watch", label: "Theo dõi & Auto", content: watch },
        ]}/>
      </aside>
    </div>
    <p className="paper-notice"><Shield size={15}/> Dữ liệu phân tích; app không giữ private key và không tự gửi giao dịch từ ví của bạn.</p>
  </main>;
}
