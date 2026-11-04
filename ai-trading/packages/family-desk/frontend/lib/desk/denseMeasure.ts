import { columnLayout, type ColumnFit, type ColumnKind } from "./denseTable.ts";

// When DenseTable has to measure its pane fit, and when it does not (D-241). Pure, so node --test can pin it (components/ui/DenseTable.tsx uses it).

/** What a column adds to the table's widths: everything about it that can change a header's or a cell's width. Not `render`: a new closure over the same column is not a new width. */
type MeasuredColumn = { key: string; label: string; kind?: string; align?: string; priority?: number; fill?: boolean; truncate?: unknown; minWidth?: number; maxWidth?: number };

/**
 * The inputs of one measure, as a string: the columns by value, the row count, whether there is an actions cell, whether the empty state shows. DenseTable measures
 * again only when this changes. Comparing the columns by identity measured a table again at every render of a parent that builds its `columns` inline (the replay
 * Portfolio tab) and at every poll of a table whose `hideWhenEmpty` column is dropped (`dropEmptyColumns` returns a new array then): two forced layouts each time.
 */
export function measureKey(columns: readonly MeasuredColumn[], rowCount: number, hasActions: boolean, showEmpty: boolean): string {
  const set = columns.map((c) => [c.key, c.label, c.kind ?? "", c.align ?? "", c.priority ?? "", c.fill ? 1 : 0, c.truncate ? 1 : 0, c.minWidth ?? "", c.maxWidth ?? ""].join("~")).join("|");
  return `${rowCount}#${hasActions ? 1 : 0}${showEmpty ? 1 : 0}#${set}`;
}

type RenderedFit = { hidden: readonly string[]; wrap: boolean };

/**
 * True when the table as it is rendered (every column shown, headers on one line) already fits its pane, so there is nothing to measure: no `data-measure` toggle, and
 * the table is laid out once instead of three times (max-content, min-content, back). That was the cost of a returning visit to the replay: the tape table (120 rows)
 * is laid out for the first time in the same frame as the rest of the page, and the measure doubled it past 50 ms at 4x CPU (D-241).
 * Sound because a cell never wraps (`white-space: nowrap`): the table is as wide as its columns' widest values, so a table no wider than its pane has columns that sum to
 * no more than the pane, which is what `fitColumns` asks of the widths it measures. A `fill` or `truncate` column ellipsizes instead, so the table can be narrow while its
 * text is not: those tables are measured. So is a table that has columns hidden or headers wrapped, because its rendered width is not its natural width.
 */
export function fitsAsRendered(columns: readonly { kind?: ColumnKind; fill?: boolean; truncate?: unknown }[], applied: RenderedFit, tableWidth: number, paneWidth: number): boolean {
  if (applied.hidden.length > 0 || applied.wrap) return false;
  if (columns.some((column) => columnLayout(column).fill || columnLayout(column).truncate)) return false;
  return tableWidth <= paneWidth;
}

/**
 * True when the table is wider than its pane although the fit it applied says everything left fits: the widths it was measured at are not the widths it has now (a placeholder was
 * measured and its value landed wider, a web font arrived), so a column that "just fitted" overflows. The caller measures again. Not when the columns that never drop overflow on their
 * own (`fits` false): there is nothing more to drop. Half a pixel is no scroll (D-243).
 */
export function measuredWidthsStale(applied: Pick<ColumnFit, "fits">, tableWidth: number, paneWidth: number): boolean {
  return applied.fits && tableWidth - paneWidth > 0.5;
}
