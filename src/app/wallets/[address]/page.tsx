import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { getTrackedWallet, listWatchedMints } from "@/db/repository";
import { fetchTokenPrices, formatUnits, getWalletActivity, getWalletHoldings, summarizeTradedTokens, WSOL_MINT, type TokenPrice, type WalletChange } from "@/lib/wallet-tracker";
import { AddToWatchlistButton } from "@/components/watch-actions";
import { RemoveWalletButton } from "@/components/wallet-controls";
export const dynamic = "force-dynamic";

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;
const usd = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : value >= 1 ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `$${value.toPrecision(3)}`;
// Display-only conversion; stored amounts stay exact.
const valueUsd = (raw: string, decimals: number, price: string | null | undefined) => price ? Number(formatUnits(raw, decimals)) * Number(price) : null;
const sol = (lamports: string) => `${formatUnits(lamports, 9)} SOL`;
const kindLabel: Record<WalletChange["kind"], string> = { buy: "Mua", sell: "Bán", swap: "Swap", receive: "Nhận", send: "Gửi", other: "Khác" };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

async function settle<T>(promise: Promise<T>): Promise<{ value: T; error: null } | { value: null; error: string }> {
  try { return { value: await promise, error: null }; } catch (error) { return { value: null, error: errorText(error) }; }
}

export default async function WalletDetail({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const wallet = await getTrackedWallet(address);
  if (!wallet) notFound();
  const [holdings, activity] = await Promise.all([settle(getWalletHoldings(address)), settle(getWalletActivity(address))]);
  const traded = activity.value ? summarizeTradedTokens(activity.value) : [];
  const mints = [...new Set([...(holdings.value?.tokens.map((item) => item.mint) ?? []), ...traded.map((item) => item.mint)])];
  const prices = await settle(fetchTokenPrices([WSOL_MINT, ...mints]));
  const watched = await listWatchedMints(mints).catch(() => new Map<string, { archived: boolean }>());
  const priceOf = (mint: string): TokenPrice | undefined => prices.value?.get(mint);
  const name = (mint: string) => priceOf(mint)?.symbol ?? short(mint);
  const solUsd = holdings.value ? valueUsd(holdings.value.lamports, 9, priceOf(WSOL_MINT)?.priceUsd) : null;
  const tokenRows = (holdings.value?.tokens ?? []).map((item) => ({ ...item, usd: valueUsd(item.amountRaw, item.decimals, priceOf(item.mint)?.priceUsd) })).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const total = [solUsd, ...tokenRows.map((item) => item.usd)].reduce<number>((sum, item) => sum + (item ?? 0), 0);
  const watchCell = (mint: string) => { const state = watched.get(mint); return state ? <Link href={`/tokens/${mint}`}>{state.archived ? "Đã lưu trữ" : "Trong watchlist"}</Link> : <AddToWatchlistButton mint={mint}/>; };

  return <main className="positions-shell"><header className="detail-top"><Link href="/wallets"><ArrowLeft size={16}/> Ví theo dõi</Link><span className="mode-pill">WATCH-ONLY</span></header><div className="positions-content">
    <div className="page-title"><div><span className="eyebrow">WALLET</span><h1>{wallet.label ?? "Ví không tên"}</h1><p><code>{wallet.address}</code> <a className="external" href={`https://solscan.io/account/${wallet.address}`} target="_blank" rel="noreferrer">Solscan <ExternalLink size={11}/></a></p></div><div className="title-actions"><RemoveWalletButton address={wallet.address} label={wallet.label ?? short(wallet.address)}/></div></div>
    <section className="position-metrics"><article><span>SOL</span><strong>{holdings.value ? sol(holdings.value.lamports) : "—"}</strong></article><article><span>Số token đang nắm</span><strong>{holdings.value ? tokenRows.length : "—"}</strong></article><article><span>Giá trị ước tính</span><strong>{holdings.value && prices.value ? usd(total) : "—"}</strong></article><article><span>Token đã giao dịch (gần đây)</span><strong>{activity.value ? traded.length : "—"}</strong></article></section>
    {[holdings.error && `Không đọc được số dư: ${holdings.error}`, activity.error && `Không đọc được lịch sử: ${activity.error}`, prices.error && `Không lấy được giá: ${prices.error}`].filter(Boolean).map((message) => <p key={String(message)} className="form-message wallet-error">{message}</p>)}

    <section className="panel"><div className="panel-head"><div><span className="eyebrow">HOLDINGS</span><h2>Token đang nắm</h2></div><span>Giá từ DexScreener</span></div><div className="table-wrap"><table className="compact-table"><thead><tr><th>Token</th><th>Số lượng</th><th>Giá</th><th>Giá trị</th><th>Watchlist</th></tr></thead><tbody>{tokenRows.length === 0 ? <tr><td colSpan={5}>{holdings.value ? "Ví không nắm token SPL nào." : "—"}</td></tr> : tokenRows.map((item) => <tr key={item.mint}><td><strong title={item.mint}>{name(item.mint)}</strong> <code>{short(item.mint)}</code></td><td>{formatUnits(item.amountRaw, item.decimals)}</td><td>{usd(priceOf(item.mint)?.priceUsd ? Number(priceOf(item.mint)!.priceUsd) : null)}</td><td>{usd(item.usd)}</td><td>{watchCell(item.mint)}</td></tr>)}</tbody></table></div></section>

    <section className="panel"><div className="panel-head"><div><span className="eyebrow">TRADED TOKENS</span><h2>Các đồng đã giao dịch</h2></div><span>Tổng hợp từ {activity.value?.length ?? 0} giao dịch gần nhất</span></div><div className="table-wrap"><table className="compact-table"><thead><tr><th>Token</th><th>Đã mua</th><th>Đã bán</th><th>SOL chi</th><th>SOL nhận</th><th>Net SOL</th><th>Số lệnh</th><th>Lần cuối</th><th>Watchlist</th></tr></thead><tbody>{traded.length === 0 ? <tr><td colSpan={9}>Không tìm thấy giao dịch mua/bán trong phạm vi đã quét.</td></tr> : traded.map((item) => { const net = BigInt(item.solReceivedLamports) - BigInt(item.solSpentLamports); return <tr key={item.mint}><td><strong title={item.mint}>{name(item.mint)}</strong></td><td>{formatUnits(item.boughtRaw, item.decimals)}</td><td>{formatUnits(item.soldRaw, item.decimals)}</td><td>{sol(item.solSpentLamports)}</td><td>{sol(item.solReceivedLamports)}</td><td className={net >= 0n ? "pnl-positive" : "pnl-negative"}>{sol(net.toString())}</td><td>{item.trades}</td><td>{item.lastTradeAt?.toLocaleString("vi-VN") ?? "—"}</td><td>{watchCell(item.mint)}</td></tr>; })}</tbody></table></div><p className="field-hint wallet-hint">SOL chi/nhận gồm cả phí ưu tiên và tiền thuê tài khoản token; chỉ phản ánh các giao dịch trong phạm vi đã quét, không phải toàn bộ lịch sử.</p></section>

    <section className="panel"><div className="panel-head"><div><span className="eyebrow">ACTIVITY</span><h2>Giao dịch gần đây</h2></div></div><div className="table-wrap"><table className="compact-table"><thead><tr><th>Thời gian</th><th>Loại</th><th>Thay đổi SOL</th><th>Thay đổi token</th><th>Phí</th><th>Transaction</th></tr></thead><tbody>{!activity.value?.length ? <tr><td colSpan={6}>Chưa có giao dịch.</td></tr> : activity.value.map((change) => <tr key={change.signature}><td>{change.blockTime?.toLocaleString("vi-VN") ?? "—"}</td><td><span className={`activity-kind ${change.kind}`}>{change.failed ? "Lỗi" : kindLabel[change.kind]}</span></td><td className={BigInt(change.solDeltaLamports) >= 0n ? "pnl-positive" : "pnl-negative"}>{change.solDeltaLamports === "0" ? "—" : sol(change.solDeltaLamports)}</td><td>{change.tokenChanges.length === 0 ? "—" : change.tokenChanges.map((token) => <div key={token.mint} className={BigInt(token.deltaRaw) >= 0n ? "pnl-positive" : "pnl-negative"}>{BigInt(token.deltaRaw) > 0n ? "+" : ""}{formatUnits(token.deltaRaw, token.decimals)} {name(token.mint)}</div>)}</td><td>{change.feeLamports === "0" ? "—" : sol(change.feeLamports)}</td><td><a className="external" href={`https://solscan.io/tx/${change.signature}`} target="_blank" rel="noreferrer">{short(change.signature)} <ExternalLink size={11}/></a></td></tr>)}</tbody></table></div></section>
  </div></main>;
}
