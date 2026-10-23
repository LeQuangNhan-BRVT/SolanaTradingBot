// Client-side filtering and sorting shared by the watchlist and discovery tables.
export type SortDirection = "asc" | "desc";
export type SortState<K extends string> = { key: K; direction: SortDirection } | null;

// Case- and accent-insensitive "contains" across several fields ("chờ" matches "cho", "FORM" matches "formation").
export function normalizeText(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().trim();
}
export function matchesQuery(query: string, fields: Array<string | null | undefined>) {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = normalizeText(fields.filter(Boolean).join(" "));
  return terms.every((term) => haystack.includes(term));
}

// Missing values always sort last, whichever the direction, so "—" rows never crowd the top.
export function sortRows<T, K extends string>(rows: T[], sort: SortState<K>, accessors: Record<K, (row: T) => number | string | null | undefined>) {
  if (!sort) return rows;
  const read = accessors[sort.key], factor = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = read(a), y = read(b);
    const missingX = x === null || x === undefined || (typeof x === "number" && Number.isNaN(x)), missingY = y === null || y === undefined || (typeof y === "number" && Number.isNaN(y));
    if (missingX || missingY) return missingX === missingY ? 0 : missingX ? 1 : -1;
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "vi")) * factor;
  });
}

// Clicking a header cycles: descending → ascending → off (numbers usually read best largest-first).
export function nextSort<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (!current || current.key !== key) return { key, direction: "desc" };
  return current.direction === "desc" ? { key, direction: "asc" } : null;
}

export const ariaSort = <K extends string>(sort: SortState<K>, key: K) => sort?.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
