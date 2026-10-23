import Link from "next/link";
import { Eye } from "lucide-react";
import { listTrackedWallets } from "@/db/repository";
import { formatUnits, getWalletBalances } from "@/lib/wallet-tracker";
import { AddWalletForm, RemoveWalletButton } from "@/components/wallet-controls";
export const dynamic = "force-dynamic";
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;

export default async function WalletsPage() {
  const wallets = await listTrackedWallets();
  let balances = new Map<string, string>(), balanceError: string | null = null;
  try { balances = await getWalletBalances(wallets.map((wallet) => wallet.address)); } catch (error) { balanceError = error instanceof Error ? error.message : String(error); }
  return <main className="positions-shell"><header className="detail-top"><span className="mode-pill">WATCH-ONLY</span></header><div className="positions-content">
    <div className="page-title"><div><span className="eyebrow">TRACKED WALLETS</span><h1>Ví theo dõi</h1><p>Chỉ lưu địa chỉ public. Ứng dụng không bao giờ yêu cầu private key ở đây.</p></div></div>
    <section className="panel wallet-panel"><div className="panel-head"><div><span className="eyebrow">ADD WALLET</span><h2>Thêm ví chỉ xem</h2></div></div><AddWalletForm/></section>
    <section className="panel"><div className="panel-head"><div><span className="eyebrow">WALLET LIST</span><h2>Danh sách ví</h2></div><span>{wallets.length} ví</span></div>
      {balanceError && <p className="form-message wallet-error">Không đọc được số dư SOL: {balanceError}</p>}
      <div className="table-wrap"><table className="compact-table"><thead><tr><th>Tên</th><th>Địa chỉ</th><th>Số dư SOL</th><th>Thêm lúc</th><th></th></tr></thead><tbody>{wallets.length === 0 ? <tr><td colSpan={5}>Chưa có ví. Thêm địa chỉ ví để xem token đang nắm và lịch sử giao dịch.</td></tr> : wallets.map((wallet) => <tr key={wallet.id}><td><Link className="position-token" href={`/wallets/${wallet.address}`}><strong><Eye size={12}/> {wallet.label ?? "Không tên"}</strong></Link></td><td><code title={wallet.address}>{short(wallet.address)}</code></td><td>{balances.has(wallet.address) ? `${formatUnits(balances.get(wallet.address)!, 9)} SOL` : "—"}</td><td>{wallet.createdAt.toLocaleString("vi-VN")}</td><td><RemoveWalletButton address={wallet.address} label={wallet.label ?? short(wallet.address)}/></td></tr>)}</tbody></table></div>
    </section>
  </div></main>;
}
