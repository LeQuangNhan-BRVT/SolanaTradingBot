"use client";
import { useFeedback } from "./feedback";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { FILTER_FIELDS, OPERATORS, type FilterField, type FilterGroup, type FilterRule, type Operator } from "@/lib/filter-rules";

export type PresetRow = { id: string; name: string; rules: FilterGroup; enabled: boolean; autoPromote: boolean };
const FIELD_KEYS = Object.keys(FILTER_FIELDS) as FilterField[];
const isGroup = (item: FilterRule | FilterGroup): item is FilterGroup => "match" in item;
const newRule = (): FilterRule => ({ field: "volume24hUsd", op: "gte", value: 20_000 });

function RuleRow({ rule, onChange, onRemove }: { rule: FilterRule; onChange: (rule: FilterRule) => void; onRemove: () => void }) {
  const field = FILTER_FIELDS[rule.field], boolean = field.kind === "boolean";
  return <div className="rule-row">
    <select value={rule.field} onChange={(event) => { const next = event.target.value as FilterField; onChange(FILTER_FIELDS[next].kind === "boolean" ? { field: next, op: "eq", value: true } : { field: next, op: "gte", value: 0 }); }}>{FIELD_KEYS.map((key) => <option key={key} value={key}>{FILTER_FIELDS[key].label}{FILTER_FIELDS[key].cost === "expensive" ? " · Helius" : ""}</option>)}</select>
    {boolean
      ? <select value={String(rule.value)} onChange={(event) => onChange({ ...rule, op: "eq", value: event.target.value === "true" })}><option value="true">Có</option><option value="false">Không</option></select>
      : <><select value={rule.op} onChange={(event) => onChange({ ...rule, op: event.target.value as Operator, ...(event.target.value === "between" ? { value2: Number(rule.value) } : { value2: undefined }) })}>{(Object.keys(OPERATORS) as Operator[]).filter((op) => op !== "eq").map((op) => <option key={op} value={op}>{OPERATORS[op]}</option>)}</select>
        <input inputMode="decimal" value={String(rule.value)} onChange={(event) => onChange({ ...rule, value: Number(event.target.value) })}/>
        {rule.op === "between" && <input inputMode="decimal" value={String(rule.value2 ?? "")} onChange={(event) => onChange({ ...rule, value2: Number(event.target.value) })}/>}</>}
    <button type="button" className="icon-button" aria-label="Xóa quy tắc" onClick={onRemove}><Trash2 size={14}/></button>
  </div>;
}

function GroupEditor({ group, onChange, depth }: { group: FilterGroup; onChange: (group: FilterGroup) => void; depth: number }) {
  const update = (index: number, item: FilterRule | FilterGroup) => onChange({ ...group, rules: group.rules.map((current, position) => position === index ? item : current) });
  const remove = (index: number) => onChange({ ...group, rules: group.rules.filter((_, position) => position !== index) });
  return <div className={`rule-group depth-${depth}`}>
    <div className="rule-group-head"><span>Khớp</span><select value={group.match} onChange={(event) => onChange({ ...group, match: event.target.value as "all" | "any" })}><option value="all">Tất cả (AND)</option><option value="any">Bất kỳ (OR)</option></select><span>quy tắc sau:</span></div>
    {group.rules.map((item, index) => isGroup(item)
      ? <div key={index} className="nested-group"><GroupEditor group={item} depth={depth + 1} onChange={(next) => update(index, next)}/><button type="button" className="ghost-button small" onClick={() => remove(index)}>Xóa nhóm</button></div>
      : <RuleRow key={index} rule={item} onChange={(next) => update(index, next)} onRemove={() => remove(index)}/>)}
    <div className="rule-actions"><button type="button" className="ghost-button small" onClick={() => onChange({ ...group, rules: [...group.rules, newRule()] })}><Plus size={13}/> Quy tắc</button>{depth < 2 && <button type="button" className="ghost-button small" onClick={() => onChange({ ...group, rules: [...group.rules, { match: "any", rules: [newRule()] }] })}><Plus size={13}/> Nhóm con</button>}</div>
  </div>;
}

export function PresetEditor({ presets }: { presets: PresetRow[] }) {
  const router = useRouter();
  const { confirm } = useFeedback();
  const blank: PresetRow = { id: "", name: "Preset mới", rules: { match: "all", rules: [newRule()] }, enabled: true, autoPromote: true };
  const [draft, setDraft] = useState<PresetRow>(presets[0] ?? blank);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  async function save() {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/discovery/presets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(draft.id ? { id: draft.id } : {}), name: draft.name, rules: draft.rules, enabled: draft.enabled, autoPromote: draft.autoPromote }) });
      const data = await response.json() as { message?: string; error?: string; preset?: PresetRow };
      setMessage(data.message ?? data.error ?? null);
      if (response.ok && data.preset) { setDraft({ ...draft, id: data.preset.id }); router.refresh(); }
    } catch { setMessage("Không thể kết nối máy chủ."); } finally { setBusy(false); }
  }
  async function remove() {
    if (!draft.id || !(await confirm({ title: `Xóa preset "${draft.name}"?`, message: "Token đã vào watchlist nhờ preset này sẽ không còn được tự lưu trữ theo nó.", confirmLabel: "Xóa preset", danger: true }))) return;
    setBusy(true);
    try { await fetch(`/api/discovery/presets?id=${draft.id}`, { method: "DELETE" }); setDraft(presets.find((preset) => preset.id !== draft.id) ?? blank); router.refresh(); } finally { setBusy(false); }
  }
  return <div className="preset-editor">
    <div className="watch-tabs">{presets.map((preset) => <button key={preset.id} type="button" className={`tab-button${draft.id === preset.id ? " active" : ""}`} onClick={() => { setDraft(preset); setMessage(null); }}>{preset.name}{!preset.enabled && " (tắt)"}</button>)}<button type="button" className={`tab-button${draft.id === "" ? " active" : ""}`} onClick={() => { setDraft(blank); setMessage(null); }}>+ Preset mới</button></div>
    <label className="preset-name">Tên preset<input value={draft.name} maxLength={40} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label>
    <GroupEditor group={draft.rules} depth={0} onChange={(rules) => setDraft({ ...draft, rules })}/>
    <div className="preset-toggles">
      <label className="watch-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}/> Bật preset</label>
      <label className="watch-toggle"><input type="checkbox" checked={draft.autoPromote} onChange={(event) => setDraft({ ...draft, autoPromote: event.target.checked })}/> Tự đưa token đạt vào watchlist</label>
    </div>
    <p className="field-hint">Trường đánh dấu "Helius" tốn credit và chỉ được đo khi các quy tắc rẻ hơn chưa đủ để kết luận. Bundle và total fees do app tự tính on-chain, có thể khác số GMGN hiển thị.</p>
    {message && <p className="form-message">{message}</p>}
    <div className="modal-actions">{draft.id && <button type="button" className="ghost-button" disabled={busy} onClick={() => void remove()}>Xóa</button>}<button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? "Đang lưu…" : "Lưu preset"}</button></div>
  </div>;
}
