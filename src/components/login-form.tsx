"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm({ nextPath }: { nextPath?: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Không thể đăng nhập.");
      router.replace(nextPath?.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/");
      router.refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Không thể đăng nhập.");
    } finally {
      setLoading(false);
    }
  }

  return <form className="login-form" onSubmit={submit}><label><span>Admin password</span><input autoFocus autoComplete="current-password" type="password" value={password} onChange={event => setPassword(event.target.value)} required/></label>{error && <p className="login-error">{error}</p>}<button disabled={loading}>{loading ? "Đang xác thực..." : "Đăng nhập"}</button></form>;
}
