import { LoginForm } from "@/components/login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <main className="login-shell"><section className="login-card"><div className="login-logo">A</div><p className="eyebrow">AEGIS TERMINAL</p><h1>Admin access</h1><p>Đăng nhập để quản lý watchlist, shadow strategy và trading controls.</p><LoginForm nextPath={next}/></section></main>;
}
