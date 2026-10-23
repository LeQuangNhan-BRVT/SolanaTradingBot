"use client";
import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

export type ThemeChoice = "dark" | "light" | "system";
const STORAGE_KEY = "aegis-theme";

// Runs before first paint (inlined in layout.tsx) so an explicit choice never flashes the other theme.
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem("${STORAGE_KEY}");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t;}catch(e){}`;

function apply(choice: ThemeChoice) {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  try { if (choice === "system") localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, choice); } catch {}
}

const OPTIONS: Array<{ value: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { value: "dark", label: "Giao diện tối", Icon: Moon },
  { value: "light", label: "Giao diện sáng", Icon: Sun },
  { value: "system", label: "Theo hệ thống", Icon: Monitor },
];

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => { const current = document.documentElement.dataset.theme; setChoice(current === "dark" || current === "light" ? current : "system"); }, []);
  return <div className="theme-toggle" role="radiogroup" aria-label="Giao diện">
    {OPTIONS.map(({ value, label, Icon }) => <button key={value} type="button" role="radio" aria-checked={choice === value} aria-label={label} title={label} className={choice === value ? "active" : ""} onClick={() => { apply(value); setChoice(value); }}><Icon size={15} aria-hidden="true"/></button>)}
  </div>;
}
