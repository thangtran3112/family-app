"use client";

import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { withPriorities } from "@/lib/desk/columns";
import type { SignalRow } from "@/lib/replay/journalView";
import styles from "./journal.module.css";

// The 15-minute change is the column that drops at the 1180 band (lib/desk/columns.ts, "practiceSignals").
const COLUMNS = withPriorities<DenseColumn<SignalRow>>(
  [
    { key: "time", label: "Time", render: (row) => row.time },
    { key: "name", label: "Strategy", render: (row) => row.name },
    { key: "close", label: "Price at close", align: "right", render: (row) => row.close },
    { key: "chg_15m", label: "Change 15 min", align: "right", render: (row) => <span className={styles[row.chg15Tone]}>{row.chg15}</span> },
    { key: "chg_30m", label: "Change 30 min", align: "right", render: (row) => <span className={styles[row.chg30Tone]}>{row.chg30}</span> },
    { key: "her", label: "What you did", render: (row) => row.her },
  ],
  "practiceSignals",
);

export type SignalsVsTradesTableProps = {
  rows: SignalRow[];
  /** Shown instead of the table when no signal fired. */
  empty: string;
};

export function SignalsVsTradesTable({ rows, empty }: SignalsVsTradesTableProps) {
  return (
    <DenseTable
      caption="Signals versus your trades"
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => row.key}
      empty={empty}
    />
  );
}
