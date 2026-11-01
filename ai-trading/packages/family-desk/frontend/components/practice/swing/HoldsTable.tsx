"use client";

import { useMemo, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { Hold } from "@/lib/replay/schemas";
import { holdRowView, type HoldRowView } from "@/lib/replay/swing";
import styles from "./board.module.css";

export type HoldsTableProps = {
  holds: readonly Hold[];
  /** Accessible name of the table; "Practice holds" by default. */
  caption?: string;
  /** Only changes the "Last" wording of the price cell (tape off reads "one-minute close"). */
  tape?: "on" | "off";
  /** The row to mark as selected (a symbol), and the click or Enter handler that makes a row selectable. */
  selectedSymbol?: string | null;
  onSelect?: (symbol: string) => void;
  /** Shown in place of the table with no holds; "No practice holds open" by default. */
  empty?: ReactNode;
  /** The SIMULATED badge under the table. Leave it on unless the screen already shows the label beside this table. */
  simulatedLabel?: boolean;
};

const tone = (value: HoldRowView["resultTone"]) => styles[value];

/**
 * Practice holds as a dense table (02p d1): symbol, side, shares, entry ("Day 3 · 184.20"), days held, stop, price,
 * unrealized P/L and R, then the earnings chip and the split note when a hold has one. An Exit column appears when a hold has closed, a Gap column
 * once a carried hold has a first price. Every figure is SIMULATED. Scrolls sideways at the 1180 band.
 */
export function HoldsTable({ holds, caption = PRACTICE_COPY.swingBoardHolds, tape = "on", selectedSymbol = null, onSelect, empty, simulatedLabel = true }: HoldsTableProps) {
  const rows = useMemo(() => holds.map((hold) => ({ hold, view: holdRowView(hold, tape) })), [holds, tape]);
  const anyClosed = rows.some((row) => row.view.status === "closed");
  const anyGap = rows.some((row) => row.view.gap !== null);
  // A column of dashes only costs width (the board's centre is about 800 px at 1440): it shows when a hold has something to say.
  const anyEarnings = rows.some((row) => row.view.earnings);
  const anySplit = rows.some((row) => row.view.splitNote);
  const selectedKey = rows.find((row) => row.view.symbol === selectedSymbol)?.view.id;

  type Row = (typeof rows)[number];
  const columns: DenseColumn<Row>[] = [
    { key: "symbol", label: "Symbol", render: ({ view }) => <span className={styles.symbol}>{view.symbol}</span> },
    { key: "side", label: "Side", render: ({ view }) => view.side },
    { key: "shares", label: "Shares", align: "right", render: ({ view }) => view.shares },
    { key: "entry", label: "Entry", render: ({ view }) => view.entry },
    { key: "held", label: "Days held", render: ({ view }) => view.held },
    { key: "stop", label: "Stop", render: ({ view }) => <span className={view.stopCrossed ? styles.amber : undefined}>{view.stop}</span> },
    { key: "value", label: "Price", render: ({ view }) => view.value },
    ...(anyGap ? [{ key: "gap", label: "Overnight gap", render: ({ view }: Row) => view.gap ?? "—" }] : []),
    {
      key: "result",
      label: anyClosed ? "P/L" : "Unrealized",
      align: "right",
      render: ({ view }) => <span className={tone(view.resultTone)}>{view.result}</span>,
    },
    { key: "r", label: "R", align: "right", render: ({ view }) => view.r },
    ...(anyClosed ? [{ key: "exit", label: "Exit", render: ({ view }: Row) => view.exit ?? "—" }] : []),
    ...(anyEarnings ? [{ key: "earnings", label: "Earnings", render: ({ view }: Row) => (view.earnings ? <Badge tone="warn">{view.earnings}</Badge> : "—") }] : []),
    ...(anySplit ? [{ key: "split", label: "Split", render: ({ view }: Row) => (view.splitNote ? <span className={styles.note}>{view.splitNote}</span> : "—") }] : []),
  ];

  return (
    <div className={styles.holds}>
      <DenseTable
        caption={caption}
        columns={columns}
        rows={rows}
        rowKey={({ view }) => String(view.id)}
        selectedKey={selectedKey === undefined ? null : String(selectedKey)}
        onSelect={onSelect ? ({ view }) => onSelect(view.symbol) : undefined}
        density="compact"
        scrollX
        empty={empty ?? <span>{PRACTICE_COPY.swingBoardNoHolds}</span>}
      />
      {simulatedLabel && rows.length > 0 && (
        <div className={styles.holdsFoot}>
          <SimulatedBadge />
        </div>
      )}
    </div>
  );
}
