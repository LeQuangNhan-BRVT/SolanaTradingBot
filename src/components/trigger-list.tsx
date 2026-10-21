"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { formatMcap, TRIGGER_LABELS, type TriggerType } from "@/lib/triggers";

export type TriggerRow = { id: string; type: string; status: string; triggerMcapUsd: string | null; trailingBps: number | null; peakMcapUsd: string | null; buyLamports: string | null; sellPctBps: number | null; maxSlippageBps: number; ocoGroup: string | null; expiresAt: string | null; lastMcapUsd: string | null; lastError: string | null; createdAt: string; filledAt: string | null; mint: string; symbol: string };
const STATUS: Record<string, string> = { active: "Đang chờ", triggered: "Đang khớp", filled: "Đã khớp", cancelled: "Đã hủy", expired: "Hết hạn", failed: "Thất bại" };
const sol = (lamports: string) => `${(Number(lamports) / 1e9).toFixed(4)} SOL`;

function condition(row: TriggerRow) {
  if (row.type === "trailing_stop") return `Giảm ${((row.trailingBps ?? 0) / 100).toFixed(1)}% từ đỉnh ${formatMcap(row.peakMcapUsd)}`;
  return `${row.type === "take_profit" ? "≥" : "≤"} ${formatMcap(row.triggerMcapUsd)}`;
}

export function TriggerList({ rows, showToken = false }: { rows: TriggerRow[]; showToken?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  async function cancel(id: string) {
    setBusy(id);
    try { const response = await fetch(`/api/triggers/${id}`, { method: "DELETE" }); if (!response.ok) window.alert(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Không thể hủy lệnh."); router.refresh(); } finally { setBusy(null); }
  }
  if (rows.length === 0) return <p className="empty-state wallet-hint">Chưa có lệnh điều kiện.</p>;
  return <div className="table-wrap"><table className="compact-table"><thead><tr>{showToken && <th>Token</th>}<th>Loại</th><th>Điều kiện</th><th>Khối lượng</th><th>Mcap gần nhất</th><th>Trạng thái</th><th>Ghi chú</th><th></th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
    {showToken && <td><Link href={`/tokens/${row.mint}`}>{row.symbol}</Link></td>}
    <td><span className={`activity-kind ${row.type === "limit_buy" ? "buy" : row.type === "take_profit" ? "swap" : "sell"}`}>{TRIGGER_LABELS[row.type as TriggerType] ?? row.type}</span>{row.ocoGroup && <span className="tag">OCO</span>}</td>
    <td>{condition(row)}</td>
    <td>{row.buyLamports ? sol(row.buyLamports) : `${((row.sellPctBps ?? 0) / 100).toFixed(0)}% vị thế`}</td>
    <td>{formatMcap(row.lastMcapUsd)}</td>
    <td>{STATUS[row.status] ?? row.status}{row.expiresAt && row.status === "active" && <small className="field-hint"> · hết hạn {new Date(row.expiresAt).toLocaleString("vi-VN")}</small>}</td>
    <td className="field-hint" title={row.lastError ?? ""}>{row.lastError?.slice(0, 70) ?? ""}</td>
    <td>{row.status === "active" && <button className="icon-button" disabled={busy === row.id} title="Hủy lệnh" aria-label={`Hủy lệnh ${row.id}`} onClick={() => cancel(row.id)}><X size={14}/></button>}</td>
  </tr>)}</tbody></table></div>;
}
