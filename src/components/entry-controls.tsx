"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { OctagonX, Pause, Play, ShieldCheck } from "lucide-react";

export function EntryControls({ initialPaused, initialHalted = false }: { initialPaused: boolean; initialHalted?: boolean }) {
  const router = useRouter();
  const [paused, setPaused] = useState(initialPaused), [halted, setHalted] = useState(initialHalted), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  async function update(body: { entriesPaused: boolean; haltAll?: boolean; reason: string | null }) {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/settings/trading", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Không thể cập nhật");
      setPaused(body.entriesPaused || Boolean(body.haltAll ?? halted)); if (body.haltAll !== undefined) setHalted(body.haltAll);
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
  }
  const halt = () => { if (window.confirm("Chặn tuyệt đối mọi giao dịch live, kể cả thoát lệnh (stop loss/risk exit)? Chỉ dùng khi nghi ngờ hệ thống lỗi.")) void update({ entriesPaused: true, haltAll: true, reason: "Emergency halt from dashboard" }); };
  const unhalt = () => { if (window.confirm("Bỏ chặn giao dịch? Entry vẫn giữ trạng thái pause; thoát lệnh sẽ chạy lại.")) void update({ entriesPaused: true, haltAll: false, reason: "Halt lifted; entries remain paused" }); };
  return <div className="entry-control">
    {halted
      ? <button className="halt-button active" onClick={unhalt} disabled={loading} title="Đang chặn mọi giao dịch live"><ShieldCheck size={16}/> Bỏ chặn giao dịch</button>
      : <><button className={paused ? "resume-button" : "pause-button"} onClick={() => update({ entriesPaused: !paused, reason: paused ? null : "Paused from dashboard" })} disabled={loading}>{paused ? <><Play size={16}/> Resume entries</> : <><Pause size={16}/> Pause entries</>}</button>
        <button className="halt-button" onClick={halt} disabled={loading} title="Chặn mọi giao dịch live, kể cả thoát lệnh"><OctagonX size={16}/> Dừng khẩn cấp</button></>}
    {error && <span>{error}</span>}
  </div>;
}
