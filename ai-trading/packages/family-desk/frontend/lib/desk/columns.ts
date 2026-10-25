import type { ShellBand } from "./viewport.ts";

// Column drop order at the 1180 band (02l §b3 rule 4, 02m §c2). Lowest priority number drops first;
// at 1180 every column that carries a priority is dropped (the mocks drop the whole list). Columns
// without a priority are never dropped. Only the screener table may scroll horizontally instead.
export const BOARD_PRIORITIES = {
  dashboard: { vs_vwap_pct: 1, rvol_10d: 2 },
  screener: { matched_since: 1, atr_pct_14: 2, volume: 3 },
  watchlist: { rvol_10d: 1, bias_label: 2 },
  // Practice (02o §a2, §a4): the notable-days table drops weekday, then attempts; signals versus trades drops the 15-minute change.
  practiceDays: { weekday: 1, attempts: 2 },
  practiceSignals: { chg_15m: 1 },
} as const satisfies Record<string, Record<string, number>>;

export type Board = keyof typeof BOARD_PRIORITIES;
export type PrioritizedColumn = { key: string; priority?: number };

export function withPriorities<T extends { key: string }>(columns: readonly T[], board: Board): Array<T & PrioritizedColumn> {
  const priorities: Record<string, number> = BOARD_PRIORITIES[board];
  return columns.map((column) => (column.key in priorities ? { ...column, priority: priorities[column.key] } : column));
}

export function columnsForBand<T extends PrioritizedColumn>(columns: readonly T[], band: ShellBand): T[] {
  return band === "1440" ? [...columns] : columns.filter((column) => column.priority === undefined);
}

/** Keys dropped at 1180, in the order they drop (lowest priority first). */
export function droppedKeys(columns: readonly PrioritizedColumn[]): string[] {
  return columns
    .filter((column): column is PrioritizedColumn & { priority: number } => column.priority !== undefined)
    .sort((a, b) => a.priority - b.priority)
    .map((column) => column.key);
}
