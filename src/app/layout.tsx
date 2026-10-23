import type { Metadata } from "next";
import "./theme.css";
import "./globals.css";
import "./db-ui.css";
import "./detail.css";
import "./watchlist.css";
import "./positions.css";
import "./health.css";
import "./performance.css";
import "./controls.css";
import "./settings.css";
import "./login.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./watch.css";
import "./trade.css";
import "./shell.css";
import "./token.css";
import { hasDatabase } from "@/db/client";
import { getTradingControls } from "@/db/repository";
import { AppShell } from "@/components/app-shell";
import { FeedbackProvider } from "@/components/feedback";
import { THEME_BOOT_SCRIPT } from "@/components/theme-toggle";
import { WalletProviders } from "@/components/wallet-providers";
import { TradeDrawerProvider } from "@/components/trade-drawer";
export const metadata: Metadata = { title: "Aegis — Solana Trading Terminal", description: "Post-migration memecoin research and paper-trading terminal" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const databaseConnected = hasDatabase();
  const controls = databaseConnected ? await getTradingControls().catch(() => ({ entriesPaused: true, haltAll: false })) : { entriesPaused: true, haltAll: false };
  const status = { mode: process.env.TRADING_MODE ?? "paper", entriesPaused: controls.entriesPaused, haltAll: controls.haltAll, databaseConnected };
  // suppressHydrationWarning: the boot script may set data-theme on <html> before React hydrates.
  return <html lang="vi" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}/></head>
    <body><WalletProviders><FeedbackProvider><TradeDrawerProvider><AppShell status={status}>{children}</AppShell></TradeDrawerProvider></FeedbackProvider></WalletProviders></body>
  </html>;
}
