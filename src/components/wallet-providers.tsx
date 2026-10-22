"use client";
import { useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { ConnectionProvider, useWallet, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";

// The multi-button reads window state, so it is rendered only on the client.
export const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((module) => module.WalletMultiButton), { ssr: false });

// A connected wallet is added to the watch-only list once, without overwriting a label the user chose.
function AutoTrackWallet() {
  const { publicKey } = useWallet();
  useEffect(() => {
    if (!publicKey) return;
    const address = publicKey.toBase58(), key = `aegis:tracked:${address}`;
    try { if (sessionStorage.getItem(key)) return; } catch {}
    void fetch("/api/wallets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, label: "Ví trình duyệt", preserveLabel: true }) })
      .then((response) => { if (response.ok) try { sessionStorage.setItem(key, "1"); } catch {} })
      .catch(() => undefined);
  }, [publicKey]);
  return null;
}

// Wallet Standard auto-detects installed wallets (Phantom, Solflare, Backpack…), so no adapters are listed explicitly.
// The browser only needs a public RPC for wallet bookkeeping; wallets broadcast through their own infrastructure.
export function WalletProviders({ children }: { children: React.ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const wallets = useMemo(() => [], []);
  return <ConnectionProvider endpoint={endpoint}><WalletProvider wallets={wallets} autoConnect><WalletModalProvider><AutoTrackWallet/>{children}</WalletModalProvider></WalletProvider></ConnectionProvider>;
}
