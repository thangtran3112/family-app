"use client";

import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { TradeRow } from "@/lib/replay/journalView";
import styles from "./journal.module.css";

const COLUMNS: DenseColumn<TradeRow>[] = [
  { key: "no", label: "#", align: "right", render: (row) => row.no },
  { key: "side", label: "Side", render: (row) => row.side },
  { key: "entry", label: "Entry", render: (row) => row.entry },
  { key: "exit", label: "Exit", render: (row) => row.exit },
  { key: "shares", label: "Shares", align: "right", render: (row) => row.shares },
  { key: "pnl", label: "P/L", align: "right", render: (row) => <span className={styles[row.pnlTone]}>{row.pnl}</span> },
  { key: "r", label: "R", align: "right", render: (row) => <span className={styles[row.pnlTone]}>{row.r}</span> },
  { key: "stop", label: "Stop", align: "right", render: (row) => row.stop },
  { key: "onSignal", label: "On a signal", render: (row) => row.onSignal },
];

export type TradesTableProps = { rows: TradeRow[] };

export function TradesTable({ rows }: TradesTableProps) {
  return (
    <DenseTable
      caption="Practice trades"
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => String(row.no)}
      empty={PRACTICE_COPY.noTradesJournal}
    />
  );
}
