"use client";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import type { Candidate } from "@/lib/types";

export function TokenRow({ token, cash, volume, bundle, cluster }: { token: Candidate; cash: string; volume: string; bundle: string; cluster: string }) {
  const router = useRouter();
  const open = () => router.push(`/tokens/${token.mint}`);
  const riskLevel = token.riskScore <= 25 ? "low" : token.riskScore <= 40 ? "medium" : "high";
  return <tr className="clickable-token-row" tabIndex={0} role="link" aria-label={`Xem chi tiết ${token.name}`} onClick={open} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}>
    <td><div className="token-cell"><div className="token-logo">{token.symbol.slice(0, 2)}</div><div><strong>{token.symbol}</strong><span title={token.mint}>{token.mint.slice(0, 5)}…{token.mint.slice(-4)}</span></div><ChevronRight className="row-chevron" size={15}/></div></td>
    <td>{token.launchpad}</td><td>{token.migratedHours === null ? "Chưa rõ" : `${token.migratedHours.toFixed(1)}h`}</td><td><span className={`risk-badge ${riskLevel}`}><i/>{token.riskScore}/100</span></td><td>{bundle}</td><td>{cluster}</td><td>{cash}</td><td>{volume}</td><td><span className={`status ${token.status}`}>{token.status === "eligible" ? "Đủ điều kiện" : token.status === "monitoring" ? "Theo dõi" : "Loại"}</span></td>
  </tr>;
}
