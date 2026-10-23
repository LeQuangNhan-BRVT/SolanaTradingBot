"use client";
import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { useFeedback } from "./feedback";

export function CopyText({ value, label }: { value: string; label: string }) {
  const { toast } = useFeedback();
  return <button type="button" className="copy-text" aria-label={label} title={label} onClick={() => { navigator.clipboard.writeText(value).then(() => toast("Đã sao chép.", "success"), () => toast("Không sao chép được.", "error")); }}>
    <code>{value}</code><Copy size={12} aria-hidden="true"/>
  </button>;
}

export type TabPanel = { id: string; label: string; content: React.ReactNode };

// Accessible tabs whose panels are rendered on the server and passed in. A matching URL hash selects a tab,
// so links like /tokens/<mint>#triggers open the right panel.
export function Tabs({ tabs, label, className = "" }: { tabs: TabPanel[]; label: string; className?: string }) {
  const [active, setActive] = useState(tabs[0]?.id);
  useEffect(() => {
    const select = () => { const hash = window.location.hash.slice(1); const match = tabs.find((tab) => tab.id === hash); if (match) { setActive(match.id); document.getElementById(`tablist-${label}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); } };
    select();
    window.addEventListener("hashchange", select);
    return () => window.removeEventListener("hashchange", select);
  }, [tabs, label]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === active);
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : -1;
    if (next >= 0) { event.preventDefault(); setActive(tabs[next].id); document.getElementById(`tab-${tabs[next].id}`)?.focus(); }
  };
  return <div className={`tabs ${className}`}>
    <div className="tab-strip" role="tablist" aria-label={label} id={`tablist-${label}`} onKeyDown={onKeyDown}>
      {tabs.map((tab) => <button key={tab.id} id={`tab-${tab.id}`} type="button" role="tab" aria-selected={active === tab.id} aria-controls={`panel-${tab.id}`} tabIndex={active === tab.id ? 0 : -1} className={active === tab.id ? "active" : ""} onClick={() => setActive(tab.id)}>{tab.label}</button>)}
    </div>
    {tabs.map((tab) => <div key={tab.id} id={`panel-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`} hidden={active !== tab.id} className="tab-panel">{tab.content}</div>)}
  </div>;
}
