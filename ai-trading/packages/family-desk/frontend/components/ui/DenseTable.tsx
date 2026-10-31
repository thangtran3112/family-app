"use client";

import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { columnsForBand } from "@/lib/desk/columns";
import { ariaSort, nextSort, sortRows, type SortState, type SortValue } from "@/lib/desk/sort";
import { useShellBand } from "@/lib/desk/useViewportBand";
import type { ShellBand } from "@/lib/desk/viewport";
import styles from "./DenseTable.module.css";

export type DenseColumn<R> = {
  key: string;
  label: string;
  render: (row: R) => ReactNode;
  /** Numbers right-aligned with tabular figures; text left-aligned. */
  align?: "left" | "right" | "center";
  /** Present: sortable header. */
  sortValue?: (row: R) => SortValue;
  /** Present: dropped at the 1180 band (lowest first, see lib/desk/columns.ts). */
  priority?: number;
  /** First click direction for sortable headers; numbers default to descending. */
  firstSort?: "asc" | "desc";
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
  selectedKey?: string | null;
  onSelect?: (row: R) => void;
  /** Hover actions in a trailing cell; they are real buttons, so keyboard focus reveals them too. */
  rowActions?: (row: R) => ReactNode;
  /** Opt-in (the practice day list, D-090): the actions show without a hover and, in a `scrollX` table, stay pinned to the scroller's right edge. Off by default: the screener and watchlists keep their hover actions. */
  alwaysShowActions?: boolean;
  /** Screener only: horizontal scroll with the first column pinned. */
  scrollX?: boolean;
  initialSort?: SortState | null;
  /** Dim every value (the quote connection dropped but last values stay visible). */
  dim?: boolean;
  /** Shown instead of the body when there are no rows. */
  empty?: ReactNode;
};

export function DenseTable<R>({
  caption,
  columns,
  rows,
  rowKey,
  band,
  density = "default",
  selectedKey = null,
  onSelect,
  rowActions,
  alwaysShowActions = false,
  scrollX = false,
  initialSort = null,
  dim = false,
  empty,
}: DenseTableProps<R>) {
  const shellBand = useShellBand();
  const [sort, setSort] = useState<SortState | null>(initialSort);
  const visible = useMemo(() => columnsForBand(columns, band ?? shellBand), [columns, band, shellBand]);
  const sorted = useMemo(() => {
    const column = sort ? visible.find((item) => item.key === sort.key) : undefined;
    return column?.sortValue && sort ? sortRows(rows, column.sortValue, sort.direction) : rows;
  }, [rows, sort, visible]);

  if (rows.length === 0 && empty) return <div className={styles.empty}>{empty}</div>;

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
    <div className={`${styles.wrap} ${scrollX ? styles.scrollX : ""} ${alwaysShowActions && rowActions ? styles.actionsPinned : ""}`} data-density={density} data-dim={dim ? "true" : undefined}>
      <table className={styles.table} aria-label={caption}>
        <thead>
          <tr>
            {visible.map((column, index) => (
              <th
                key={column.key}
                scope="col"
                className={`${column.align === "right" ? styles.right : column.align === "center" ? styles.center : ""} ${scrollX && index === 0 ? styles.sticky : ""}`}
                aria-sort={column.sortValue ? ariaSort(sort, column.key) : undefined}
              >
                {column.sortValue ? (
                  <button type="button" className={styles.sortButton} onClick={() => setSort(nextSort(sort, column.key, column.firstSort ?? (column.align === "right" ? "desc" : "asc")))}>
                    {column.label}
                    <span aria-hidden="true" className={styles.caret}>{sort?.key === column.key ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
                  </button>
                ) : column.label}
              </th>
            ))}
            {rowActions && <th scope="col" className={styles.actionsHead}><span className={styles.srOnly}>Actions</span></th>}
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
                {visible.map((column, index) => (
                  <td key={column.key} className={`${column.align === "right" ? styles.right : column.align === "center" ? styles.center : ""} ${scrollX && index === 0 ? styles.sticky : ""}`}>
                    {column.render(row)}
                  </td>
                ))}
                {rowActions && <td className={styles.actions} onClick={(event) => event.stopPropagation()}>{rowActions(row)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
