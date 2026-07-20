import type { Metadata } from "next";
import "./globals.css";
import "./db-ui.css";
import "./detail.css";
import "./watchlist.css";
export const metadata: Metadata = { title: "Aegis — Solana Trading Terminal", description: "Post-migration memecoin research and paper-trading terminal" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="vi"><body>{children}</body></html>; }
