import type { Metadata } from "next";
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
import "./watch.css";
import { AdminLogout } from "@/components/admin-logout";
export const metadata: Metadata = { title: "Aegis — Solana Trading Terminal", description: "Post-migration memecoin research and paper-trading terminal" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="vi"><body>{children}<AdminLogout/></body></html>; }
