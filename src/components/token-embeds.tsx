"use client";
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

// Resolves the effective theme (explicit data-theme, else the OS preference) and follows changes.
function useEffectiveTheme() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const read = () => { const explicit = document.documentElement.dataset.theme; setTheme(explicit === "light" || explicit === "dark" ? explicit : media.matches ? "light" : "dark"); };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", read);
    return () => { observer.disconnect(); media.removeEventListener("change", read); };
  }, []);
  return theme;
}

export function DexScreenerChart({ pairAddress, mint }: { pairAddress: string | null; mint: string }) {
  const theme = useEffectiveTheme();
  if (!pairAddress) return <div className="embed-placeholder">Chưa có pool để hiển thị biểu đồ.</div>;
  const src = `https://dexscreener.com/solana/${pairAddress}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=${theme}&theme=${theme}&chartStyle=1&chartType=usd&interval=15`;
  return <div className="embed-frame">
    <iframe key={src} src={src} title="Biểu đồ giá DexScreener" loading="lazy" referrerPolicy="no-referrer"/>
    <a className="external embed-link" href={`https://dexscreener.com/solana/${mint}`} target="_blank" rel="noreferrer">Mở DexScreener <ExternalLink size={11} aria-hidden="true"/></a>
  </div>;
}

// Bubblemaps is the holder map DexScreener embeds. Its iframe needs a partner id: "demo" is for testing only.
export function BubbleMap({ mint }: { mint: string }) {
  const partnerId = process.env.NEXT_PUBLIC_BUBBLEMAPS_PARTNER_ID || "demo";
  return <div className="embed-frame tall">
    <iframe src={`https://iframe.bubblemaps.io/map?address=${mint}&chain=solana&partnerId=${encodeURIComponent(partnerId)}`} title="Bản đồ holder Bubblemaps" loading="lazy" allow="clipboard-write" referrerPolicy="no-referrer"/>
    <p className="field-hint embed-note">{partnerId === "demo" ? "Đang dùng mã thử nghiệm của Bubblemaps; nếu bản đồ không tải được, mở trực tiếp trên Bubblemaps." : "Bản đồ từ Bubblemaps."} <a className="external" href={`https://app.bubblemaps.io/sol/token/${mint}`} target="_blank" rel="noreferrer">Mở trên Bubblemaps <ExternalLink size={11} aria-hidden="true"/></a></p>
  </div>;
}
