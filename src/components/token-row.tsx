"use client";
import { useRouter } from "next/navigation";
import { ChevronRight, Pin } from "lucide-react";
import type { Candidate } from "@/lib/types";
import { WatchActions } from "./watch-actions";

const price = (value: string | null | undefined) => { if (!value) return "—"; const number = Number(value); return number >= 1 ? `$${number.toLocaleString("en-US", { maximumFractionDigits: 4 })}` : `$${number.toPrecision(4)}`; };

export function TokenRow({ token, cash, volume, bundle, cluster }: { token: Candidate; cash: string; volume: string; bundle: string; cluster: string }) {
  const router = useRouter();
  const open = () => router.push(`/tokens/${token.mint}`);
  const riskLevel = token.riskScore <= 25 ? "low" : token.riskScore <= 40 ? "medium" : "high";
  const watch = token.watch ?? { note: null, tags: [], pinned: false, archived: false, autoTrade: false };
  return <tr className="clickable-token-row" tabIndex={0} role="link" aria-label={`Xem chi tiết ${token.name}`} onClick={open} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}>
    <td><div className="token-cell"><div className="token-logo">{token.symbol.slice(0, 2)}</div><div><strong>{watch.pinned && <Pin className="pin-mark" size={11}/>}{token.symbol}</strong><span title={token.mint}>{token.mint.slice(0, 5)}…{token.mint.slice(-4)}</span>{watch.note && <em className="watch-note" title={watch.note}>{watch.note}</em>}</div><ChevronRight className="row-chevron" size={15}/></div></td>
    <td>{price(token.priceUsd)}</td><td>{token.launchpad}</td><td>{token.migratedHours === null ? "Chưa rõ" : `${token.migratedHours.toFixed(1)}h`}</td><td><span className={`risk-badge ${riskLevel}`}><i/>{token.riskScore}/100</span></td><td>{bundle}</td><td>{cluster}</td><td>{cash}</td><td>{volume}</td><td><span className={`status ${token.status}`}>{token.status === "eligible" ? "Đủ điều kiện" : token.status === "monitoring" ? "Theo dõi" : "Loại"}</span></td>
    <td><div className="tag-list">{watch.autoTrade && <span className="tag auto">AUTO</span>}{watch.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div></td>
    <td><WatchActions mint={token.mint} symbol={token.symbol} pinned={watch.pinned} archived={watch.archived}/></td>
  </tr>;
}
