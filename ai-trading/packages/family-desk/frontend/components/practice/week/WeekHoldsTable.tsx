"use client";

import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { WEEK_TEXT } from "@/lib/replay/weekScreen";
import type { WeekHoldRowView } from "@/lib/replay/weekView";
import styles from "./week.module.css";

// At 1180 the three columns with a priority drop (lowest first): days held, gap P/L, then R.
const COLUMNS: DenseColumn<WeekHoldRowView>[] = [
  {
    key: "symbol",
    label: "Symbol",
    render: (row) => (
      <>
        <span className={styles.cellStrong}>{row.symbol}</span> <span className={styles.cellMuted}>{row.side}</span>
      </>
    ),
  },
  { key: "shares", label: "Shares", align: "right", render: (row) => row.shares },
  { key: "entry", label: "Entry", render: (row) => row.entry },
  { key: "exit", label: "Exit", render: (row) => row.exit },
  { key: "held", label: "Held", priority: 1, render: (row) => row.held },
  { key: "pnl", label: "P/L", align: "right", render: (row) => <span className={styles[row.pnlTone]}>{row.pnl}</span> },
  { key: "r", label: "R", align: "right", priority: 3, render: (row) => row.r },
  { key: "gap", label: "Gap P/L", align: "right", priority: 2, render: (row) => row.gap },
  { key: "stop", label: "Stop", render: (row) => <span className={row.stopAway ? styles.amber : undefined}>{row.stop}</span> },
  { key: "rank", label: "Rank", align: "right", render: (row) => row.rank },
  { key: "selection", label: "Selection", align: "right", render: (row) => row.selection },
  { key: "timing", label: "Timing", align: "right", render: (row) => row.timing },
];

/** Every hold active in the week: where it was entered and left, what it made, whether its stop held, how it ranked in the universe. */
export function WeekHoldsTable({ rows }: { rows: WeekHoldRowView[] }) {
  return <DenseTable caption={WEEK_TEXT.holdsCaption} columns={COLUMNS} rows={rows} rowKey={(row) => String(row.holdId)} density="compact" empty={PRACTICE_COPY.swingNoHoldsWeek} />;
}
