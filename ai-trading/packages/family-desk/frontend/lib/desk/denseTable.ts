import { EMPTY_VALUE } from "./format.ts";

// The rules DenseTable applies to its columns, kept pure so node --test can check them (components/ui/DenseTable.tsx renders them).

export type ColumnKind = "text" | "num" | "action";
export type CellAlign = "left" | "right" | "center";

/** Numbers and actions sit on the right edge of their column (so digits line up); text on the left. An explicit `align` wins. */
export function cellAlign(column: { kind?: ColumnKind; align?: CellAlign }): CellAlign {
  return column.align ?? (column.kind === "num" || column.kind === "action" ? "right" : "left");
}

/** A cell that shows nothing: no node, an empty string, or the em dash. An element counts as content. */
export function isEmptyCell(value: unknown): boolean {
  return value === null || value === undefined || value === false || value === "" || value === EMPTY_VALUE;
}

/** Drops each `hideWhenEmpty` column whose cell is empty in every row. With no rows it keeps all columns: the empty state speaks instead. Nothing dropped: `columns` itself, so a table whose rows change but whose columns do not keeps one list (and is not measured again). */
export function dropEmptyColumns<R, C extends { hideWhenEmpty?: boolean; render: (row: R) => unknown }>(columns: readonly C[], rows: readonly R[]): readonly C[] {
  if (rows.length === 0) return columns;
  const kept = columns.filter((column) => !column.hideWhenEmpty || rows.some((row) => !isEmptyCell(column.render(row))));
  return kept.length === columns.length ? columns : kept;
}

/** The tooltip of a truncating cell: the text it clips, from `truncate` itself when that is a function, else from a string or number `render`. */
export function cellTitle<R>(column: { truncate?: boolean | ((row: R) => string); render: (row: R) => unknown }, row: R): string | undefined {
  if (!column.truncate) return undefined;
  if (typeof column.truncate === "function") return column.truncate(row);
  const value = column.render(row);
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** What a column does with its width. A `num` column is never clipped. A `fill` column takes the slack and ellipsizes; a `truncate` column that is not `fill` holds exactly `minWidth` and ellipsizes. */
export function columnLayout(column: { kind?: ColumnKind; fill?: boolean; truncate?: unknown; minWidth?: number }): { fill: boolean; truncate: boolean; style: { width?: number; minWidth?: number; maxWidth?: number } | undefined } {
  const clips = column.kind !== "num";
  const fill = clips && Boolean(column.fill);
  const truncate = clips && Boolean(column.truncate);
  const { minWidth } = column;
  if (minWidth === undefined) return { fill, truncate, style: undefined };
  return { fill, truncate, style: truncate && !fill ? { width: minWidth, minWidth, maxWidth: minWidth } : { minWidth } };
}

// -- pane fit (D-157) ---------------------------------------------------------------------------------------------------------
// A table that does not fit its pane drops columns, lowest `priority` first, before it ever clips or scrolls a value. The pane is the
// table's own container, not the viewport. DenseTable measures each column's natural width and calls this with the pane's width.

/** One column as DenseTable measured it: `max` is its width with the header on one line, `min` with the header wrapped to its longest word. A value never wraps. */
export type ColumnWidth = { key: string; priority?: number; max: number; min: number };

/** What fits the pane: the keys to hide, whether the headers wrap to get there, and whether the table fits at all (false: only the columns without a priority are left and they still overflow). */
export type ColumnFit = { hidden: string[]; wrap: boolean; fits: boolean };

/** Hide columns lowest priority first (the rightmost of equal priorities first) until the rest fit `pane`; `reserved` is the width of what never drops (the actions cell). */
function dropUntilFit(columns: readonly ColumnWidth[], reserved: number, pane: number, size: "max" | "min"): { hidden: string[]; fits: boolean } {
  const order = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.priority !== undefined)
    .sort((a, b) => a.column.priority! - b.column.priority! || b.index - a.index);
  const hidden: string[] = [];
  let width = reserved + columns.reduce((sum, column) => sum + column[size], 0);
  for (const { column } of order) {
    if (width <= pane) break;
    hidden.push(column.key);
    width -= column[size];
  }
  return { hidden, fits: width <= pane };
}

/**
 * The columns a pane holds. First with every header on one line: drop columns by priority until the rest fit. If the columns without a priority
 * overflow even then, the headers may wrap, and the drop starts again from the full set at the wrapped widths: a header is the one text that
 * wraps, and only when nothing else is left to give. Whatever stays is whole.
 */
export function fitColumns(columns: readonly ColumnWidth[], reserved: { max: number; min: number }, pane: number): ColumnFit {
  const natural = dropUntilFit(columns, reserved.max, pane, "max");
  if (natural.fits) return { hidden: natural.hidden, wrap: false, fits: true };
  const wrapped = dropUntilFit(columns, reserved.min, pane, "min");
  return { hidden: wrapped.hidden, wrap: true, fits: wrapped.fits };
}
