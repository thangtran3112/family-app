"use client";

import Link from "next/link";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { WeekRow } from "@/lib/replay/swingApi";
import { weekReviewable, weekRowView, type WeekRowView } from "@/lib/replay/weekView";
import styles from "./threadJournal.module.css";

type Row = { view: WeekRowView; reviewable: boolean };

/**
 * One row per week opened so far (02p h): the headline figures of its review, and a link to the review itself. An open
 * week shows "Week to date" and links once a day of it has ended. Every dollar figure is SIMULATED (the section's badge).
 */
export function SwingWeeksTable({ threadId, weeks, daysEnded }: { threadId: number; weeks: readonly WeekRow[]; daysEnded: number }) {
  const rows: Row[] = weeks.map((week) => ({ view: weekRowView(week), reviewable: weekReviewable(week, daysEnded) }));
  const columns: DenseColumn<Row>[] = [
    {
      key: "week",
      label: "Week",
      render: ({ view, reviewable }) =>
        reviewable ? (
          <Link href={`/practice/week?thread=${threadId}&week=${view.weekNo}`} className={styles.link}>{view.label}</Link>
        ) : (
          view.label
        ),
    },
    { key: "days", label: "Days", render: ({ view }) => view.days },
    { key: "status", label: "Status", render: ({ view }) => view.status },
    { key: "realized", label: "Realized", align: "right", render: ({ view }) => <span className={styles[view.realizedTone]}>{view.realized}</span> },
    { key: "equity", label: "Equity change", align: "right", render: ({ view }) => <span className={styles[view.equityChangeTone]}>{view.equityChange}</span> },
    { key: "adherence", label: "Adherence", align: "right", render: ({ view }) => view.adherence },
    { key: "selection", label: "Selection", align: "right", render: ({ view }) => view.selection },
    { key: "timing", label: "Timing", align: "right", render: ({ view }) => view.timing },
  ];
  return (
    <div className={styles.tableWrap}>
      <DenseTable caption="Weeks" columns={columns} rows={rows} rowKey={({ view }) => String(view.weekNo)} empty={PRACTICE_COPY.swingWeeksNone} />
    </div>
  );
}
