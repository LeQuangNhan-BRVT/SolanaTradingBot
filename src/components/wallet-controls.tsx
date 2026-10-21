"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";

export function AddWalletForm() {
  const router = useRouter();
  const [address, setAddress] = useState(""), [label, setLabel] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/wallets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: address.trim(), label: label.trim() || null }) });
      const data = await response.json() as { message?: string; error?: string };
      setMessage(data.message ?? data.error ?? null);
      if (response.ok) { setAddress(""); setLabel(""); router.refresh(); }
    } catch { setMessage("Không thể kết nối máy chủ."); } finally { setBusy(false); }
  }
  return <form className="wallet-form" onSubmit={submit}>
    <input required value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Địa chỉ ví public (không nhập private key)" aria-label="Địa chỉ ví"/>
    <input value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} placeholder="Tên gợi nhớ" aria-label="Tên ví"/>
    <button className="primary-button" disabled={busy} type="submit"><Plus size={16}/> {busy ? "Đang lưu…" : "Thêm ví"}</button>
    {message && <p className="form-message">{message}</p>}
  </form>;
}

export function RemoveWalletButton({ address, label }: { address: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return <button className="icon-button" disabled={busy} title="Bỏ theo dõi" aria-label={`Bỏ theo dõi ${label}`} onClick={async () => { if (!window.confirm(`Bỏ theo dõi ví ${label}?`)) return; setBusy(true); try { const response = await fetch(`/api/wallets/${address}`, { method: "DELETE" }); if (!response.ok) window.alert(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Không thể xóa ví."); router.push("/wallets"); router.refresh(); } finally { setBusy(false); } }}><Trash2 size={15}/></button>;
}
