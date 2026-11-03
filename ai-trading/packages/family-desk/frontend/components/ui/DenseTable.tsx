"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { cellAlign, cellTitle, columnLayout, dropEmptyColumns, fitColumns, type CellAlign, type ColumnFit, type ColumnKind, type ColumnWidth } from "@/lib/desk/denseTable";
import { measureKey } from "@/lib/desk/denseMeasure";
import { ariaSort, nextSort, sortRows, type SortState, type SortValue } from "@/lib/desk/sort";
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
  /** Present: the column may drop. When the table does not fit its pane (its own container, never the viewport) the lowest number drops first, only as many as it takes; a column without one never drops. See `fitColumns`. */
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

const FITS_ALL: ColumnFit = { hidden: [], wrap: false, fits: true };
const sameFit = (a: ColumnFit, b: ColumnFit) => a.wrap === b.wrap && a.fits === b.fits && a.hidden.join("|") === b.hidden.join("|");

const alignClass = (column: { kind?: ColumnKind; align?: CellAlign }) => {
  const align = cellAlign(column);
  return align === "right" ? styles.right : align === "center" ? styles.center : "";
};

export function DenseTable<R>({
  caption,
  columns,
  rows,
  rowKey,
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
  const [sort, setSort] = useState<SortState | null>(initialSort);
  const visible = useMemo(() => dropEmptyColumns(columns, rows), [columns, rows]);
  const showEmpty = rows.length === 0 && Boolean(empty);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Pane fit (D-157): every column is rendered; `fit` says which are hidden (`data-dropped`) and whether the headers wrap.
  const [fit, setFit] = useState<ColumnFit>(FITS_ALL);
  const dropped = useMemo(() => new Set(fit.hidden), [fit.hidden]);
  const measured = useRef<{ columns: ColumnWidth[]; reserved: { max: number; min: number } } | null>(null);
  const applied = useRef<ColumnFit>(FITS_ALL);
  const hasActions = Boolean(rowActions);
  // The fit is set only when it differs from the one applied: a set to an equal value still renders the table, and `flushSync` of it lays the page out again (D-241).
  const apply = useCallback((next: ColumnFit, sync: boolean) => {
    if (sameFit(applied.current, next)) return;
    applied.current = next;
    if (sync) flushSync(() => setFit(next));
    else setFit(next);
  }, []);
  const settle = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || !measured.current) return;
    apply(fitColumns(measured.current.columns, measured.current.reserved, wrap.clientWidth), false);
  }, [apply]);
  // What the measure reads is the render's columns, but it runs again only when `measureKey` changes: the effect below cannot list them as a dependency.
  const latest = useRef({ visible, hasActions });
  useLayoutEffect(() => {
    latest.current = { visible, hasActions };
  });
  const measureId = measureKey(visible, rows.length, hasActions, showEmpty);
  // Measure before paint, so a column that does not fit is never shown: each header cell's width with the table at its natural width (one-line
  // headers, then wrapped headers), the dropped columns shown for the measure (CSS `data-measure`). Again when the columns (by value) or the number of rows change, not when
  // a poll only changes the values or a parent passes the same columns in a new array (D-212, D-241), so a table that refreshes every 2 s is not laid out twice more each time.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let live = true;
    // Reads the widths; returns the fit when it differs from the one applied, so the caller sets it (in the frame, inside `flushSync`) only then.
    const measure = (): ColumnFit | null => {
      const { visible: columns, hasActions: actions } = latest.current;
      const heads = Array.from(wrap.querySelectorAll<HTMLElement>("thead th"));
      const widthsAt = (size: "max" | "min") => {
        wrap.dataset.measure = size;
        return heads.map((head) => head.getBoundingClientRect().width);
      };
      const max = widthsAt("max");
      const min = widthsAt("min");
      delete wrap.dataset.measure;
      measured.current = {
        columns: columns.map((column, index) => ({ key: column.key, ...(column.priority === undefined ? {} : { priority: column.priority }), max: max[index] ?? 0, min: min[index] ?? 0 })),
        reserved: actions ? { max: max[columns.length] ?? 0, min: min[columns.length] ?? 0 } : { max: 0, min: 0 },
      };
      const next = fitColumns(measured.current.columns, measured.current.reserved, wrap.clientWidth);
      return sameFit(applied.current, next) ? null : next;
    };
    // The measure runs in the next frame's animation callback, which is still before that frame's paint, so a column that does not fit is still never
    // shown. Run inside the commit's layout effect it put the page's first layout, the measure's own two and React's render in one task: a long task
    // when a 30-row table mounts (D-235). `flushSync` applies the fit before the paint, as the layout effect's own state update did; with no change
    // to apply there is no render and no second layout.
    const frame = requestAnimationFrame(() => {
      if (!live) return;
      const next = measure();
      if (next) apply(next, true);
      // A letter's width is what is being summed, so a measure taken before the web font arrived is taken again once it is in. The status is read after the
      // measure, when the layout it forced has started any font the table needs: with the fonts loaded (a returning visit) there is no second pass, which
      // would only read the same widths in two more forced layouts (D-235, D-241).
      if (document.fonts && document.fonts.status !== "loaded") {
        void document.fonts.ready.then(() => {
          const again = live ? measure() : null;
          if (again) apply(again, false);
        });
      }
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [measureId, apply]);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(settle);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [showEmpty, settle]);
  // The scroll edge shadow: the wrapper says which edges have more to scroll to; the CSS draws the shadow (no re-render on scroll).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!scrollX || !wrap) return;
    const update = () => {
      wrap.dataset.scrolled = String(wrap.scrollLeft > 0);
      wrap.dataset.more = String(wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1);
    };
    // No read here: `update` forced the first layout of a table that was just mounted, inside the commit's task (D-235). The observer reports the wrapper's and
    // the table's size once they are laid out, before the first paint, and calls `update` then.
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
      data-wrap={fit.wrap ? "true" : undefined}
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
                  data-dropped={dropped.has(column.key) ? "" : undefined}
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
                    <td key={column.key} data-dropped={dropped.has(column.key) ? "" : undefined} className={`${alignClass(column)} ${scrollX && index === 0 ? styles.sticky : ""} ${fill ? styles.fill : ""}`} style={style}>
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
