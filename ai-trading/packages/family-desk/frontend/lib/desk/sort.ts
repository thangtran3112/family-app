export type SortDirection = "asc" | "desc";
export type SortState = { key: string; direction: SortDirection };
export type SortValue = number | string | null | undefined;

const isEmpty = (value: SortValue) => value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value));

/** Stable sort; empty values (null, NaN) always go last, whatever the direction. */
export function sortRows<R>(rows: readonly R[], valueOf: (row: R) => SortValue, direction: SortDirection): R[] {
  const sign = direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: valueOf(row) }))
    .sort((a, b) => {
      const aEmpty = isEmpty(a.value);
      const bEmpty = isEmpty(b.value);
      if (aEmpty || bEmpty) return aEmpty === bEmpty ? a.index - b.index : aEmpty ? 1 : -1;
      const order = typeof a.value === "number" && typeof b.value === "number"
        ? a.value - b.value
        : String(a.value).localeCompare(String(b.value), "en", { numeric: true });
      return order === 0 ? a.index - b.index : order * sign;
    })
    .map(({ row }) => row);
}

/** Clicking a header: first click sorts descending for numbers feel natural in tables of movers; same key flips; third click clears. */
export function nextSort(current: SortState | null, key: string, firstDirection: SortDirection = "desc"): SortState | null {
  if (!current || current.key !== key) return { key, direction: firstDirection };
  if (current.direction === firstDirection) return { key, direction: firstDirection === "desc" ? "asc" : "desc" };
  return null;
}

export const ariaSort = (state: SortState | null, key: string): "ascending" | "descending" | "none" =>
  state?.key === key ? (state.direction === "asc" ? "ascending" : "descending") : "none";
