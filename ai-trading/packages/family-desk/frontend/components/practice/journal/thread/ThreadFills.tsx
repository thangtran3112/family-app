"use client";

import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { QueryBoundary } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { withPriorities } from "@/lib/desk/columns";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { dayLabels, fillRows, loadThreadFills, type FillRow } from "@/lib/replay/fills";
import type { Thread } from "@/lib/replay/threads";
import styles from "./threadJournal.module.css";

const COLUMNS = withPriorities<DenseColumn<FillRow>>(
  [
    { key: "day", label: "Day", render: (row) => row.day },
    { key: "time", label: "Time (ET)", render: (row) => row.time },
    { key: "symbol", label: "Symbol", render: (row) => row.symbol },
    { key: "action", label: "Action", render: (row) => row.action },
    { key: "shares", label: "Shares", kind: "num", render: (row) => row.shares },
    { key: "price", label: "Price", kind: "num", render: (row) => row.price },
    { key: "effect", label: "Effect", render: (row) => row.effect },
  ],
  "threadFills",
);

/** Every Buy and Sell of a day thread, newest first, as the server booked them. Day threads only: a swing thread has no fills route. */
export function ThreadFills({ thread }: { thread: Thread }) {
  const id = thread.thread.id;
  const query = useDeskQuery(`thread-fills:${id}`, (signal) => loadThreadFills(id, { signal }));
  return (
    <section className={styles.section} aria-labelledby="thread-fills-title">
      <div className={styles.sectionHead}>
        <h2 id="thread-fills-title" className={styles.sectionTitle}>{PRACTICE_COPY.fillsTitle}</h2>
        <SimulatedBadge />
      </div>
      <QueryBoundary query={query} loading={PRACTICE_COPY.fillsLoading} height={96} message={PRACTICE_COPY.fillsLoadError}>
        {(data) => (
          <>
            <DenseTable caption={PRACTICE_COPY.fillsCaption} columns={COLUMNS} rows={fillRows(data.fills, dayLabels(thread))} rowKey={(row) => row.key} empty={PRACTICE_COPY.fillsEmpty} />
            {data.total > data.fills.length && <p className={styles.hint}>{practiceText("fillsMore", { shown: data.fills.length, total: data.total })}</p>}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
