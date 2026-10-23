"use client";
import { useRouter } from "next/navigation";
import { ChevronRight, Pin } from "lucide-react";
import type { Candidate } from "@/lib/types";
import { WatchActions } from "./watch-actions";

export type WatchColumn = "price" | "launchpad" | "migrated" | "risk" | "bundle" | "cluster" | "liquidity" | "volume" | "status" | "tags";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cash = (value: number | null) => value === null ? "—" : usd.format(value);
const pct = (value: number | null) => value === null ? "—" : `${value.toFixed(2)}%`;
const price = (value: string | null | undefined) => { if (!value) return "—"; const number = Number(value); return number >= 1 ? `$${number.toLocaleString("en-US", { maximumFractionDigits: 4 })}` : `$${number.toPrecision(4)}`; };
const STATUS = { eligible: "✓ Đủ điều kiện", monitoring: "? Theo dõi", rejected: "✕ Loại" } as const;

export function TokenRow({ token, columns }: { token: Candidate; columns: Set<WatchColumn> }) {
  const router = useRouter();
  const open = () => router.push(`/tokens/${token.mint}`);
  const riskLevel = token.riskScore <= 25 ? "low" : token.riskScore <= 40 ? "medium" : "high";
  const watch = token.watch ?? { note: null, tags: [], pinned: false, archived: false, autoTrade: false };
  const show = (column: WatchColumn) => columns.has(column);
  return <tr className="clickable-token-row" tabIndex={0} role="link" aria-label={`Xem chi tiết ${token.name}`} onClick={open} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}>
    <td><div className="token-cell"><div className="token-logo">{token.symbol.slice(0, 2)}</div><div><strong>{watch.pinned && <Pin className="pin-mark" size={11} aria-label="Đã ghim"/>}{token.symbol}</strong><span title={token.mint}>{token.mint.slice(0, 5)}…{token.mint.slice(-4)}</span>{watch.note && <em className="watch-note" title={watch.note}>{watch.note}</em>}</div><ChevronRight className="row-chevron" size={15} aria-hidden="true"/></div></td>
    {show("price") && <td>{price(token.priceUsd)}</td>}
    {show("launchpad") && <td>{token.launchpad}</td>}
    {show("migrated") && <td>{token.migratedHours === null ? "—" : `${token.migratedHours.toFixed(1)}h`}</td>}
    {show("risk") && <td><span className={`risk-badge ${riskLevel}`}><i/>{token.riskScore}/100</span></td>}
    {show("bundle") && <td>{pct(token.bundlePct)}</td>}
    {show("cluster") && <td>{pct(token.clusterPct)}</td>}
    {show("liquidity") && <td>{cash(token.liquidityUsd)}</td>}
    {show("volume") && <td>{cash(token.volume1hUsd)}</td>}
    {show("status") && <td><span className={`status ${token.status}`}>{STATUS[token.status]}</span></td>}
    {show("tags") && <td><div className="tag-list">{watch.autoTrade && <span className="tag auto">AUTO</span>}{watch.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div></td>}
    <td><WatchActions mint={token.mint} symbol={token.symbol} pinned={watch.pinned} archived={watch.archived}/></td>
  </tr>;
}
