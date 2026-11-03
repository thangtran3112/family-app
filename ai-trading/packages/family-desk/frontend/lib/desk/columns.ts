import type { ReactNode } from "react";
import type { CellAlign, ColumnKind } from "./denseTable.ts";
import { EMPTY_VALUE, formatMetric, signTone, type MetricFormat, type SignTone } from "./format.ts";
import type { SortValue } from "./sort.ts";

// Column drop order (02l §b3 rule 4, 02m §c2; pane-driven since D-157). Lowest priority number drops first, and only as many columns
// drop as it takes for the table to fit its pane (`fitColumns` in denseTable.ts, applied by components/ui/DenseTable). Columns
// without a priority are never dropped, so they are the set a board must be able to show whole in its narrowest pane.
export const BOARD_PRIORITIES = {
  dashboard: { vs_vwap_pct: 1, rvol_10d: 2 },
  screener: { matched_since: 1, atr_pct_14: 2, volume: 3 },
  watchlist: { rvol_10d: 1, bias_label: 2 },
  // Practice (02o §a2, §a4): the notable-days table drops weekday, then attempts; signals versus trades drops the 15-minute change.
  practiceDays: { weekday: 1, attempts: 2 },
  practiceSignals: { chg_15m: 1 },
  // Daily-list practice (02o-b v1, D-157): the candidate table drops the time the match began, then volume, gap and vs VWAP, then prev close. It keeps price
  // at list, price now, vs prev close, prev RVOL, prev change, ATR %, RSI and earnings, whatever the pane. The filter names have no priority: they say why
  // each name is on the Screen, so they never drop (D-223).
  // A filter that reads the 52-week high adds its two numbers (D-243); they drop after the previous close and before everything else.
  practiceList: { matched_since: 1, volume: 2, gap_pct_open: 3, vs_vwap_pct: 4, prev_close: 5, high_252d: 6, dist_to_252d_high_pct: 7 },
  // The same Screen once the scan was read after the open (D-243), when it carries the scan's own RVOL and change % and, with them, 18 columns that no pane holds.
  // The first five drop as above. Then what a column beside it already says: the scan's change % (the same move as "vs prev close %", or "vs prev close % now"
  // following the clock), then the previous session's change and RVOL, which the scan's own RVOL and the move now replace; last the filter's own numbers beyond the
  // fixed block (52-week high, distance from it). What never drops: the name (symbol, filters: they say why it is listed, D-223), the scan price, the price now and
  // its move, RVOL (the scan's), ATR %, RSI and earnings: 1,064 px with the pinned actions beside the widest Filters cell measured (186 px; 162 on the walks),
  // inside the 1,088 px pane at 1440 and the 1,108 px pane at 1180. A scan read before the open keeps `practiceList`: its previous-session figures are its figures.
  practiceListOpen: { matched_since: 1, volume: 2, gap_pct_open: 3, vs_vwap_pct: 4, prev_close: 5, change_pct: 6, prev_change_pct: 7, prev_rvol: 8, high_252d: 9, dist_to_252d_high_pct: 10 },
  practiceReview: { range_pct: 1, close_move_pct: 2 },
  // The Trades fills table (D-157): what a fill did to the position goes first (the action says Buy or Sell), then the day; the time, name, size and price stay.
  threadFills: { effect: 1, day: 2 },
  // Fundamental lane (02n §b3, "1180 column drop orders"): Holdings drops next earnings, the AI rating, open calls, then unrealized %;
  // the candidates drop spread, open interest, return if called, then upside cap; open calls drop moneyness, then contracts; the brief drops the 30-day EPS revision, then confidence.
  fundHoldings: { next_earnings: 1, ai_rating: 2, open_calls: 3, unrealized_pct: 4 },
  fundCandidates: { spread_pct: 1, open_interest: 2, return_if_called: 3, upside_cap: 4 },
  fundShortCalls: { moneyness_pct: 1, contracts: 2 },
  fundBrief: { eps_rev_30d_pct: 1, confidence: 2 },
  // The swing board (02p d1): average dollar volume goes first, then distance from the 50-day average, the 5-day change and RSI.
  boardView: { avg_dollar_volume_20d: 1, vs_50d_avg_pct: 2, chg_5d_pct: 3, rsi_14: 4 },
} as const satisfies Record<string, Record<string, number>>;

export type Board = keyof typeof BOARD_PRIORITIES;
export type PrioritizedColumn = { key: string; priority?: number };

export function withPriorities<T extends { key: string }>(columns: readonly T[], board: Board): Array<T & PrioritizedColumn> {
  const priorities: Record<string, number> = BOARD_PRIORITIES[board];
  return columns.map((column) => (column.key in priorities ? { ...column, priority: priorities[column.key] } : column));
}

/** Keys that may drop, in the order they drop (lowest priority first). */
export function droppedKeys(columns: readonly PrioritizedColumn[]): string[] {
  return columns
    .filter((column): column is PrioritizedColumn & { priority: number } => column.priority !== undefined)
    .sort((a, b) => a.priority - b.priority)
    .map((column) => column.key);
}

// -- column specs ------------------------------------------------------------------------------------------------------------

/** One description of a metric column for every board: the label, how to format it, where it aligns, when it drops. */
export type ColumnSpec = {
  key: string;
  label: string;
  format: MetricFormat | "text";
  /** Default: text and time read left, every other format right. */
  align?: CellAlign;
  /** Present: may drop when the pane is too narrow (see `BOARD_PRIORITIES`; `withPriorities` fills it). */
  priority?: number;
  /** The direction of the first click on the header; unset leaves the table's default (numbers biggest first). */
  firstSort?: "asc" | "desc";
};

/** What `columnFromSpec` returns: structurally a `DenseColumn`, built here so lib does not import a component. */
export type SpecColumn<R> = {
  key: string;
  label: string;
  kind: ColumnKind;
  align: CellAlign;
  priority?: number;
  firstSort?: "asc" | "desc";
  sortValue: (row: R) => SortValue;
  render: (row: R) => ReactNode;
};

/**
 * A table column from a spec. The cell is `formatMetric(spec.format, value)`; `paint` wraps a `pct_signed` cell in its
 * `signTone` (up, down or neutral), and no other format carries a tone. `value` is the raw number, string or null.
 */
export function columnFromSpec<R>(
  spec: ColumnSpec,
  value: (row: R) => number | string | null,
  paint?: (text: string, tone: SignTone) => ReactNode,
): SpecColumn<R> {
  const text = spec.format === "text" || spec.format === "time";
  const format = spec.format === "text" ? "number" : spec.format;
  return {
    key: spec.key,
    label: spec.label,
    kind: text ? "text" : "num",
    align: spec.align ?? (text ? "left" : "right"),
    ...(spec.priority === undefined ? {} : { priority: spec.priority }),
    ...(spec.firstSort === undefined ? {} : { firstSort: spec.firstSort }),
    sortValue: value,
    render: (row) => {
      const raw = value(row);
      // A text column shows its string as it is; every other format goes through formatMetric.
      const shown = spec.format === "text" ? (raw === null ? EMPTY_VALUE : String(raw)) : formatMetric(format, raw);
      return paint && spec.format === "pct_signed" ? paint(shown, signTone(typeof raw === "number" ? raw : null)) : shown;
    },
  };
}
