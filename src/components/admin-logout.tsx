"use client";

import { LogOut } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

export function AdminLogout() {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname === "/login") return null;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return <button className="admin-logout" onClick={logout} title="Đăng xuất"><LogOut size={15}/> Đăng xuất</button>;
}
