"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EMPTY_VALUE } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { positionCells, type Cell, type PositionCells, type PositionRow } from "@/lib/replay/positionTable";
import styles from "./positionTable.module.css";

/** What a day thread's table can do: open a name's chart (`busy` is the symbol being opened or exited, which holds every other row), and exit a held one. */
export type PositionActions = { busy: string | null; onOpen: (symbol: string) => void; onExit: (row: PositionRow) => void };

/** A cell: its text in the sign's colour (a dash is muted). */
function cellText(row: PositionRow, pick: (cells: PositionCells) => Cell, { strong = false }: { strong?: boolean } = {}): ReactNode {
  const { text, tone } = pick(positionCells(row));
  const classes = [tone === null ? "" : styles[tone], strong ? styles.strong : ""].filter(Boolean).join(" ");
  return classes === "" ? text : <span className={classes}>{text}</span>;
}

/** The columns that leave the table when they are a dash in every row: a swing hold has no prior close to change from and nothing realized. */
const LEAVES_WHEN_EMPTY: Record<string, (cells: PositionCells) => Cell> = {
  change: (cells) => cells.change,
  changePct: (cells) => cells.changePct,
  realized: (cells) => cells.realized,
};

function columns(actions: PositionActions | undefined): DenseColumn<PositionRow>[] {
  return [
    {
      key: "symbol",
      label: "Ticker",
      render: (row) =>
        actions === undefined ? (
          <span className={styles.symbol}>{row.symbol}</span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className={styles.ticker}
            aria-label={practiceText("dayOpen", { symbol: row.symbol })}
            aria-current={row.current ? "true" : undefined}
            aria-disabled={!row.current && actions.busy !== null ? "true" : undefined}
            loading={actions.busy === row.symbol}
            onClick={() => {
              if (!row.current && actions.busy === null) actions.onOpen(row.symbol);
            }}
          >
            {row.symbol}
          </Button>
        ),
    },
    { key: "last", label: "Last", kind: "num", render: (row) => cellText(row, (cells) => cells.last) },
    { key: "change", label: "Change", kind: "num", priority: 2, render: (row) => cellText(row, (cells) => cells.change) },
    { key: "changePct", label: "Change %", kind: "num", priority: 1, render: (row) => cellText(row, (cells) => cells.changePct) },
    { key: "position", label: "Position", kind: "num", render: (row) => cellText(row, (cells) => cells.position) },
    { key: "avg", label: "Avg price", kind: "num", render: (row) => cellText(row, (cells) => cells.avg) },
    { key: "value", label: "Value", kind: "num", priority: 3, render: (row) => cellText(row, (cells) => cells.value) },
    { key: "unrealized", label: "Unrealized P/L", kind: "num", priority: 5, render: (row) => cellText(row, (cells) => cells.unrealized) },
    { key: "realized", label: "Realized P/L", kind: "num", priority: 4, render: (row) => cellText(row, (cells) => cells.realized) },
    { key: "total", label: "Total P/L", kind: "num", render: (row) => cellText(row, (cells) => cells.total, { strong: true }) },
    { key: "held", label: "Held", priority: 6, hideWhenEmpty: true, render: (row) => row.held ?? "" },
    {
      key: "status",
      label: "Status",
      hideWhenEmpty: true,
      render: (row) =>
        row.current || row.behind || row.stop !== null ? (
          <span className={styles.flags}>
            {row.current && <Badge tone="up">{PRACTICE_COPY.dayOnNow}</Badge>}
            {row.behind && <Badge tone="neutral" title={PRACTICE_COPY.dayBehind}>{PRACTICE_COPY.dayBehindShort}</Badge>}
            {row.stop !== null && <Badge tone="warn">{row.stop}</Badge>}
          </span>
        ) : null,
    },
  ];
}

/**
 * The position table of the Portfolio tab, one per mode, read like a broker's list: Ticker, Last, Change, Change %, Position (signed shares),
 * Avg price (what the position was built at), Value (position at the mark), Unrealized, Realized and Total P/L. All SIMULATED. A figure the payload
 * does not hold is a dash; a column that is a dash in every row (a swing hold has no prior close and nothing realized) leaves the table. With
 * `actions` a ticker opens that name's chart and a held row has Exit; without, the rows only read (a swing thread, an ended day).
 */
export function PositionTable({ caption, rows, empty, actions }: { caption: string; rows: readonly PositionRow[]; empty?: string; actions?: PositionActions }) {
  const exitDisabled = actions === undefined || actions.busy !== null;
  return (
    <DenseTable
      caption={caption}
      columns={columns(actions).filter((column) => {
        const pick = LEAVES_WHEN_EMPTY[column.key];
        return pick === undefined || rows.length === 0 || rows.some((row) => pick(positionCells(row)).text !== EMPTY_VALUE);
      })}
      rows={rows}
      rowKey={(row) => row.key}
      selectedKey={rows.find((row) => row.current)?.key ?? null}
      rowActions={actions === undefined ? undefined : (row) =>
        row.side === null ? null : (
          <Button size="sm" disabled={exitDisabled} aria-label={practiceText("dayPortfolioExit", { symbol: row.symbol })} onClick={() => actions.onExit(row)}>
            {PRACTICE_COPY.dayPortfolioExitButton}
          </Button>
        )}
      empty={empty}
    />
  );
}
