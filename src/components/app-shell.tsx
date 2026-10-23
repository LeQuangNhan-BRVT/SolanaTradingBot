"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Crosshair, Eye, HeartPulse, ListOrdered, LogOut, PanelLeftClose, PanelLeftOpen, Radar, Settings, Shield, Wallet } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { WalletButton } from "./wallet-providers";

const NAV = [
  { href: "/", label: "Watchlist", Icon: Crosshair, match: (path: string) => path === "/" || path.startsWith("/tokens") },
  { href: "/discovery", label: "Khám phá", Icon: Radar },
  { href: "/orders", label: "Lệnh điều kiện", Icon: ListOrdered },
  { href: "/positions", label: "Vị thế", Icon: Wallet },
  { href: "/performance", label: "Performance", Icon: Activity },
  { href: "/wallets", label: "Ví theo dõi", Icon: Eye },
  { href: "/live-safety", label: "Live safety", Icon: Shield },
];
const FOOTER_NAV = [
  { href: "/settings", label: "Cài đặt", Icon: Settings },
  { href: "/health", label: "System health", Icon: HeartPulse },
];
const MODE_LABEL: Record<string, string> = { paper: "PAPER", shadow: "SHADOW", live: "LIVE" };

export type ShellStatus = { mode: string; entriesPaused: boolean; haltAll: boolean; databaseConnected: boolean };

export function AppShell({ status, children }: { status: ShellStatus; children: React.ReactNode }) {
  const pathname = usePathname(), router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { try { setCollapsed(localStorage.getItem("aegis-sidebar") === "collapsed"); } catch {} }, []);
  if (pathname === "/login") return <>{children}</>;
  const toggle = () => { const next = !collapsed; setCollapsed(next); try { localStorage.setItem("aegis-sidebar", next ? "collapsed" : "open"); } catch {} };
  const isActive = (item: { href: string; match?: (path: string) => boolean }) => item.match ? item.match(pathname) : pathname === item.href || pathname.startsWith(`${item.href}/`);
  const link = (item: { href: string; label: string; Icon: typeof Crosshair; match?: (path: string) => boolean }) => <Link key={item.href} href={item.href} className={isActive(item) ? "active" : ""} aria-current={isActive(item) ? "page" : undefined} title={collapsed ? item.label : undefined}><item.Icon size={18} aria-hidden="true"/><span>{item.label}</span></Link>;
  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); router.replace("/login"); router.refresh(); }

  return <div className={`shell${collapsed ? " collapsed" : ""}`}>
    <aside className="shell-sidebar" aria-label="Điều hướng chính">
      <div className="shell-brand"><div className="brand-mark" aria-hidden="true">A</div><div className="shell-brand-text"><strong>AEGIS</strong><span>SOLANA TERMINAL</span></div></div>
      <nav className="shell-nav">{NAV.map(link)}</nav>
      <nav className="shell-nav shell-nav-footer" aria-label="Hệ thống">{FOOTER_NAV.map(link)}
        <button type="button" className="shell-collapse" onClick={toggle} aria-label={collapsed ? "Mở rộng menu" : "Thu gọn menu"}>{collapsed ? <PanelLeftOpen size={18} aria-hidden="true"/> : <PanelLeftClose size={18} aria-hidden="true"/>}<span>Thu gọn</span></button>
      </nav>
    </aside>
    <div className="shell-main">
      <header className="shell-topbar">
        <div className="shell-status">
          <span className={`status-pill mode-${status.mode}`}>{MODE_LABEL[status.mode] ?? status.mode.toUpperCase()}</span>
          {status.haltAll ? <Link href="/live-safety" className="status-pill danger">⛔ TRADING HALTED</Link> : status.entriesPaused ? <Link href="/live-safety" className="status-pill warn">⏸ ENTRIES PAUSED</Link> : null}
          {!status.databaseConnected && <span className="status-pill danger">DATABASE OFFLINE</span>}
        </div>
        <div className="shell-actions">
          <ThemeToggle/>
          <div className="manual-head"><WalletButton/></div>
          <button type="button" className="icon-button" onClick={() => void logout()} aria-label="Đăng xuất" title="Đăng xuất"><LogOut size={16} aria-hidden="true"/></button>
        </div>
      </header>
      <div className="shell-content">{children}</div>
    </div>
  </div>;
}
