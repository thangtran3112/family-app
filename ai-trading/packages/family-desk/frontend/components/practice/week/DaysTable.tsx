"use client";

import Link from "next/link";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { WEEK_TEXT, type LinkedDayRow } from "@/lib/replay/weekScreen";
import styles from "./week.module.css";

const COLUMNS: DenseColumn<LinkedDayRow>[] = [
  {
    key: "day",
    label: "Day",
    render: (row) =>
      row.href === null ? (
        row.title
      ) : (
        <Link href={row.href} className={`${styles.link} ${styles.dayLink}`}>
          {row.title}
        </Link>
      ),
  },
  { key: "watched", label: "Watched", render: (row) => row.watched },
  { key: "entries", label: "Entries", align: "right", render: (row) => row.entries },
  { key: "exits", label: "Exits", align: "right", render: (row) => row.exits },
  { key: "realized", label: "Realized", align: "right", render: (row) => <span className={styles[row.realizedTone]}>{row.realized}</span> },
  { key: "gap", label: "Gap", align: "right", render: (row) => <span className={styles[row.gapTone]}>{row.gap}</span> },
  { key: "intraday", label: "Intraday", align: "right", render: (row) => <span className={styles[row.intradayTone]}>{row.intraday}</span> },
  { key: "adherence", label: "Adherence", align: "right", render: (row) => row.adherence },
];

/** One row per day of the week; a day's name opens its board in its ended state. Money is SIMULATED (the section says so). */
export function DaysTable({ rows }: { rows: LinkedDayRow[] }) {
  return <DenseTable caption={WEEK_TEXT.daysCaption} columns={COLUMNS} rows={rows} rowKey={(row) => String(row.dayNo)} density="compact" empty={PRACTICE_COPY.swingWeeksNone} />;
}
