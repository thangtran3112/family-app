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

/** Drops each `hideWhenEmpty` column whose cell is empty in every row. With no rows it keeps all columns: the empty state speaks instead. */
export function dropEmptyColumns<R, C extends { hideWhenEmpty?: boolean; render: (row: R) => unknown }>(columns: readonly C[], rows: readonly R[]): C[] {
  if (rows.length === 0) return [...columns];
  return columns.filter((column) => !column.hideWhenEmpty || rows.some((row) => !isEmptyCell(column.render(row))));
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
