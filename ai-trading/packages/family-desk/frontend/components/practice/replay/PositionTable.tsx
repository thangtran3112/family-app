"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { orderRows, positionCells, type Cell, type OrderRow, type PositionCells, type PositionRow } from "@/lib/replay/positionTable";
import { replayHref } from "@/lib/replay/practiceTabs";
import styles from "./positionTable.module.css";

/** What the table can do: exit a held position (`busy` is the symbol being exited, which holds every other row). Without it the rows only read (a closed thread). */
export type PositionActions = { busy: string | null; onExit: (row: PositionRow) => void };

/** A cell: its text in the sign's colour (a dash is muted). */
function cellText(row: PositionRow, pick: (cells: PositionCells) => Cell, { strong = false }: { strong?: boolean } = {}): ReactNode {
  const { text, tone } = pick(positionCells(row));
  const classes = [tone === null ? "" : styles[tone], strong ? styles.strong : ""].filter(Boolean).join(" ");
  return classes === "" ? text : <span className={classes}>{text}</span>;
}

function columns(): DenseColumn<PositionRow>[] {
  return [
    {
      key: "symbol",
      label: "Ticker",
      render: (row) => (
        <Button client href={replayHref(row.sessionId)} variant="ghost" size="sm" className={styles.ticker} aria-label={practiceText("portfolioOpen", { symbol: row.symbol })}>
          {row.symbol}
        </Button>
      ),
    },
    { key: "side", label: "Side", priority: 3, render: (row) => cellText(row, (cells) => cells.side) },
    { key: "shares", label: "Shares", kind: "num", render: (row) => cellText(row, (cells) => cells.shares) },
    { key: "avg", label: "Avg cost", kind: "num", render: (row) => cellText(row, (cells) => cells.avg) },
    {
      key: "price",
      label: "Price at thread time",
      kind: "num",
      render: (row) => (
        <span className={styles.priceCell}>
          {cellText(row, (cells) => cells.price)}
          {row.priceNote !== null && <span className={styles.note}>{row.priceNote}</span>}
        </span>
      ),
    },
    { key: "unrealized", label: "Gain/loss", kind: "num", render: (row) => cellText(row, (cells) => cells.unrealized, { strong: true }) },
    { key: "heldFor", label: "Held for", kind: "num", priority: 2, render: (row) => cellText(row, (cells) => cells.heldFor) },
    { key: "orders", label: "Working orders", kind: "num", priority: 1, render: (row) => cellText(row, (cells) => cells.orders) },
    {
      key: "status",
      label: "Status",
      hideWhenEmpty: true,
      render: (row) => (row.stop === null ? null : <Badge tone="warn">{row.stop}</Badge>),
    },
  ];
}

/**
 * The position table of the Portfolio tab, read like a broker's list of what she holds now (ADR-0025): Ticker (a link to its chart), Side, Shares,
 * Avg cost (what the position was built at), Price at thread time (the price at the thread clock, with a note when it is old), Gain/loss (never dropped),
 * Held for (elapsed thread time, "3d 4h") and the working orders on the name. A closed trade is not a row: its result is in Trades. All
 * SIMULATED. With `actions` a held row has Exit; without, the rows only read.
 */
export function PositionTable({ caption, rows, empty, actions }: { caption: string; rows: readonly PositionRow[]; empty?: string; actions?: PositionActions }) {
  return (
    <DenseTable
      caption={caption}
      columns={columns()}
      rows={rows}
      rowKey={(row) => row.key}
      rowActions={actions === undefined ? undefined : (row) => (
        <Button size="sm" disabled={actions.busy !== null} aria-label={practiceText("portfolioExit", { symbol: row.symbol })} onClick={() => actions.onExit(row)}>
          {PRACTICE_COPY.portfolioExitButton}
        </Button>
      )}
      empty={empty}
    />
  );
}

const ORDER_COLUMNS: DenseColumn<OrderRow>[] = [
  { key: "symbol", label: "Ticker", render: (row) => <span className={styles.symbol}>{row.symbol}</span> },
  { key: "kind", label: "Order", render: (row) => row.kind },
  { key: "shares", label: "Shares", kind: "num", render: (row) => row.shares },
  { key: "price", label: "Price", kind: "num", render: (row) => row.price },
  { key: "tif", label: "Time in force", priority: 2, render: (row) => row.tif },
  {
    key: "expires",
    label: "Expires",
    priority: 1,
    hideWhenEmpty: true,
    render: (row) => (
      <span className={styles.flags}>
        {row.expires}
        {row.reduceOnly && <Badge tone="neutral">{PRACTICE_COPY.portfolioReduceOnly}</Badge>}
      </span>
    ),
  },
];

/** The thread's working orders, across its lanes: what rests, how long it lasts (GTC, or Day with its expiry) and whether it can only close a position. */
export function OrderTable({ orders }: { orders: Parameters<typeof orderRows>[0] }) {
  return <DenseTable caption={PRACTICE_COPY.portfolioOrdersTitle} columns={ORDER_COLUMNS} rows={orderRows(orders)} rowKey={(row) => row.key} empty={PRACTICE_COPY.portfolioOrdersNone} />;
}
