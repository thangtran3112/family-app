"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { columnsForBand } from "@/lib/desk/columns";
import { cellAlign, cellTitle, columnLayout, dropEmptyColumns, type CellAlign, type ColumnKind } from "@/lib/desk/denseTable";
import { ariaSort, nextSort, sortRows, type SortState, type SortValue } from "@/lib/desk/sort";
import { useShellBand } from "@/lib/desk/useViewportBand";
import type { ShellBand } from "@/lib/desk/viewport";
import styles from "./DenseTable.module.css";

export type DenseColumn<R> = {
  key: string;
  label: string;
  render: (row: R) => ReactNode;
  /** `num`: right-aligned, tabular, never clipped. `action`: right-aligned buttons. `text` (default): left-aligned. */
  kind?: ColumnKind;
  /** Overrides the alignment `kind` implies. */
  align?: CellAlign;
  /** Present: sortable header. */
  sortValue?: (row: R) => SortValue;
  /** Present: dropped at the 1180 band (lowest first, see lib/desk/columns.ts). */
  priority?: number;
  /** First click direction for sortable headers; numbers default to descending. */
  firstSort?: "asc" | "desc";
  /** The one column that gives way (its text ellipsizes) so the others stay whole in a table narrower than its content. */
  fill?: boolean;
  /** Clip the cell with an ellipsis and put the full text in its tooltip: pass a function for the tooltip text when `render` does not return a string or number. Needs `fill` or `minWidth` to bound it; ignored on `num`. */
  truncate?: boolean | ((row: R) => string);
  /** px. The column never gets narrower; on a `truncate` column that is not `fill` it is also the width. */
  minWidth?: number;
  /** Drop the column when its cell is empty (nothing, "" or the em dash) in every row. */
  hideWhenEmpty?: boolean;
};

export type DenseTableProps<R> = {
  /** Accessible name of the table. */
  caption: string;
  columns: readonly DenseColumn<R>[];
  rows: readonly R[];
  rowKey: (row: R) => string;
  band?: ShellBand;
  /** 28 px rows by default, 24 px for compact rails. */
  density?: "default" | "compact";
  /** 4 px cell padding for a table that must fit its column without scrolling; the first and last cells keep the `--dense-edge` gutter (default `--space-3`; a wrapper may set it). */
  tight?: boolean;
  selectedKey?: string | null;
  onSelect?: (row: R) => void;
  /** Actions in a trailing cell; they are real buttons. In a `scrollX` table the cell stays pinned to the scroller's right edge. */
  rowActions?: (row: R) => ReactNode;
  /** `always` (default): visible without a hover, so touch and sight can reach them. `hover`: shown on hover and keyboard focus, for the densest tables only. */
  actions?: "always" | "hover";
  /** Horizontal scroll with the first column pinned; a soft shadow marks each edge that has more to scroll to. */
  scrollX?: boolean;
  initialSort?: SortState | null;
  /** Dim every value (the quote connection dropped but last values stay visible). */
  dim?: boolean;
  /** Shown instead of the body when there are no rows. */
  empty?: ReactNode;
};

const alignClass = (column: { kind?: ColumnKind; align?: CellAlign }) => {
  const align = cellAlign(column);
  return align === "right" ? styles.right : align === "center" ? styles.center : "";
};

export function DenseTable<R>({
  caption,
  columns,
  rows,
  rowKey,
  band,
  density = "default",
  tight = false,
  selectedKey = null,
  onSelect,
  rowActions,
  actions = "always",
  scrollX = false,
  initialSort = null,
  dim = false,
  empty,
}: DenseTableProps<R>) {
  const shellBand = useShellBand();
  const [sort, setSort] = useState<SortState | null>(initialSort);
  const visible = useMemo(() => dropEmptyColumns(columnsForBand(columns, band ?? shellBand), rows), [columns, rows, band, shellBand]);
  const showEmpty = rows.length === 0 && Boolean(empty);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The scroll edge shadow: the wrapper says which edges have more to scroll to; the CSS draws the shadow (no re-render on scroll).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!scrollX || !wrap) return;
    const update = () => {
      wrap.dataset.scrolled = String(wrap.scrollLeft > 0);
      wrap.dataset.more = String(wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1);
    };
    update();
    wrap.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(wrap);
    if (wrap.firstElementChild) observer.observe(wrap.firstElementChild);
    return () => {
      wrap.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [scrollX, showEmpty]);
  const sorted = useMemo(() => {
    const column = sort ? visible.find((item) => item.key === sort.key) : undefined;
    return column?.sortValue && sort ? sortRows(rows, column.sortValue, sort.direction) : rows;
  }, [rows, sort, visible]);

  if (showEmpty) return <div className={styles.empty}>{empty}</div>;

  function onKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: R) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect?.(row);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const sibling = event.key === "ArrowDown" ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
      if (sibling instanceof HTMLElement) sibling.focus();
    }
  }

  return (
    <div
      ref={wrapRef}
      className={`${styles.wrap} ${scrollX ? styles.scrollX : ""} ${scrollX && rowActions ? styles.actionsPinned : ""}`}
      data-density={density}
      data-tight={tight ? "true" : undefined}
      data-actions={rowActions ? actions : undefined}
      data-dim={dim ? "true" : undefined}
    >
      <table className={styles.table} aria-label={caption}>
        <thead>
          <tr>
            {visible.map((column, index) => {
              const { fill, style } = columnLayout(column);
              return (
                <th
                  key={column.key}
                  scope="col"
                  className={`${alignClass(column)} ${scrollX && index === 0 ? styles.sticky : ""} ${fill ? styles.fill : ""}`}
                  style={style}
                  aria-sort={column.sortValue ? ariaSort(sort, column.key) : undefined}
                >
                  {column.sortValue ? (
                    <button type="button" className={styles.sortButton} onClick={() => setSort(nextSort(sort, column.key, column.firstSort ?? (cellAlign(column) === "right" ? "desc" : "asc")))}>
                      {column.label}
                      <span aria-hidden="true" className={styles.caret}>{sort?.key === column.key ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
                    </button>
                  ) : column.label}
                </th>
              );
            })}
            {rowActions && <th scope="col" className={styles.actionsHead}><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            const selected = key === selectedKey;
            return (
              <tr
                key={key}
                className={`${styles.row} ${selected ? styles.selected : ""} ${onSelect ? styles.clickable : ""}`}
                aria-selected={onSelect ? selected : undefined}
                tabIndex={onSelect ? 0 : undefined}
                onClick={onSelect ? () => onSelect(row) : undefined}
                onKeyDown={onSelect ? (event) => onKeyDown(event, row) : undefined}
              >
                {visible.map((column, index) => {
                  const { fill, truncate, style } = columnLayout(column);
                  return (
                    <td key={column.key} className={`${alignClass(column)} ${scrollX && index === 0 ? styles.sticky : ""} ${fill ? styles.fill : ""}`} style={style}>
                      {truncate ? <span className={styles.clip} title={cellTitle(column, row)}>{column.render(row)}</span> : column.render(row)}
                    </td>
                  );
                })}
                {rowActions && <td className={styles.actions} onClick={(event) => event.stopPropagation()}>{rowActions(row)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
