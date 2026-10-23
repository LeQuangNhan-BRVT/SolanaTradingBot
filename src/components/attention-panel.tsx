import Link from "next/link";
import { AlertTriangle, BellRing, CheckCircle2, Info } from "lucide-react";
import type { AttentionItem } from "@/lib/attention";

const ICON = { danger: BellRing, warning: AlertTriangle, info: Info } as const;
const VISIBLE = 6;

function ago(iso: string | null, now: number) {
  if (!iso) return "hiện tại";
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  return minutes < 1 ? "vừa xong" : minutes < 60 ? `${minutes} phút trước` : minutes < 1_440 ? `${Math.round(minutes / 60)} giờ trước` : `${Math.round(minutes / 1_440)} ngày trước`;
}

function Row({ item, now }: { item: AttentionItem; now: number }) {
  const Icon = ICON[item.tone];
  return <li className={`attention-item ${item.tone}`}>
    <Icon size={16} aria-hidden="true"/>
    <div><strong>{item.title}</strong><span>{item.detail}</span></div>
    <time dateTime={item.at ?? undefined}>{ago(item.at, now)}</time>
    <Link className={item.tone === "danger" ? "primary-button small" : "ghost-button small"} href={item.href}>{item.action}</Link>
  </li>;
}

// Server-rendered: what needs the user's hand first (fired TP/SL alerts, stuck or failed orders), then recent events from the last 24h.
export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const now = Date.now(), urgent = items.filter((item) => item.tone === "danger").length;
  return <section className="panel attention-panel" aria-labelledby="attention-title">
    <div className="panel-head"><div><span className="eyebrow">24 GIỜ QUA</span><h2 id="attention-title">Cần chú ý</h2></div>{items.length > 0 && <span className={`attention-count${urgent ? " urgent" : ""}`}>{urgent ? `${urgent} cần xử lý · ` : ""}{items.length} mục</span>}</div>
    {!items.length ? <p className="attention-empty"><CheckCircle2 size={16} aria-hidden="true"/> Không có gì cần xử lý.</p> : <>
      <ul className="attention-list">{items.slice(0, VISIBLE).map((item) => <Row key={item.id} item={item} now={now}/>)}</ul>
      {items.length > VISIBLE && <details className="attention-more"><summary>Xem thêm {items.length - VISIBLE} mục</summary><ul className="attention-list">{items.slice(VISIBLE).map((item) => <Row key={item.id} item={item} now={now}/>)}</ul></details>}
    </>}
  </section>;
}
