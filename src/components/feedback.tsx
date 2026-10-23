"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

type Tone = "success" | "error" | "warning" | "info";
type Toast = { id: number; message: string; tone: Tone };
type ConfirmOptions = { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean };
type Feedback = { toast: (message: string, tone?: Tone) => void; confirm: (options: ConfirmOptions) => Promise<boolean> };

const FeedbackContext = createContext<Feedback | null>(null);
const ICONS = { success: CheckCircle2, error: XCircle, warning: AlertTriangle, info: Info };

// App-level replacement for window.alert / window.confirm: themed toasts and an accessible modal built on <dialog>.
export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (value: boolean) => void }) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((items) => items.filter((item) => item.id !== id)), []);
  const toast = useCallback((message: string, tone: Tone = "info") => {
    const id = ++counter.current;
    setToasts((items) => [...items.slice(-3), { id, message, tone }]);
    setTimeout(() => dismiss(id), tone === "error" ? 8_000 : 4_500);
  }, [dismiss]);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })), []);

  useEffect(() => { if (pending && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [pending]);
  const settle = (value: boolean) => { pending?.resolve(value); setPending(null); dialog.current?.close(); };

  return <FeedbackContext.Provider value={{ toast, confirm }}>
    {children}
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((item) => { const Icon = ICONS[item.tone]; return <div key={item.id} className={`toast ${item.tone}`}><Icon size={16} aria-hidden="true"/><span>{item.message}</span><button type="button" className="toast-close" aria-label="Đóng thông báo" onClick={() => dismiss(item.id)}><X size={14} aria-hidden="true"/></button></div>; })}
    </div>
    <dialog ref={dialog} className="confirm-dialog" aria-labelledby="confirm-title" onCancel={(event) => { event.preventDefault(); settle(false); }}>
      {pending && <form method="dialog" onSubmit={(event) => { event.preventDefault(); settle(true); }}>
        <h2 id="confirm-title">{pending.title}</h2>
        {pending.message && <p>{pending.message}</p>}
        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={() => settle(false)} autoFocus>{pending.cancelLabel ?? "Hủy"}</button>
          <button type="submit" className={pending.danger ? "danger-button" : "primary-button"}>{pending.confirmLabel ?? "Xác nhận"}</button>
        </div>
      </form>}
    </dialog>
  </FeedbackContext.Provider>;
}

export function useFeedback() {
  const context = useContext(FeedbackContext);
  if (!context) throw new Error("useFeedback must be used inside FeedbackProvider.");
  return context;
}
