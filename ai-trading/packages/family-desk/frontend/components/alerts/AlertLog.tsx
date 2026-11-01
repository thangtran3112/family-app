"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, QueryBoundary } from "@/components/ui/StateBlocks";
import type { AlertLogRow } from "@/lib/api/schemas";
import { loadAlertLog } from "@/lib/desk/alerts";
import { deliveryTone, LOG_STATUSES, logRowText } from "@/lib/desk/alertsView";
import { channelLabel, deliveryLabel } from "@/lib/desk/labels";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "./alerts.module.css";

const columns: DenseColumn<AlertLogRow>[] = [
  { key: "when", label: "Time", render: (row) => logRowText(row).when },
  { key: "what", label: "Alert", render: (row) => logRowText(row).what },
  { key: "channel", label: "Channel", render: (row) => channelLabel(row.channel) },
  { key: "result", label: "Result", render: (row) => <Badge tone={deliveryTone(row.status)}>{deliveryLabel(row.status)}</Badge> },
  { key: "detail", label: "Detail", render: (row) => <span className={styles.wrap}>{row.detail}</span> },
];

/** Log tab of D9: every delivery attempt, newest first (02m §a3.7). */
export function AlertLog() {
  const [status, setStatus] = useState("");
  const log = useDeskQuery(
    `alert-log:${status}`,
    (signal) => loadAlertLog({ status: status || undefined, limit: 50 }, { signal }),
    { intervalMs: 60_000 },
  );

  const body = (
    <QueryBoundary
      query={log}
      loading="Loading delivery log…"
      subject="delivery log"
      isEmpty={(rows) => rows.length === 0}
      empty={
        <EmptyBlock title="Nothing delivered yet">
          <Link href="/alerts/new" className={styles.link}>New alert strategy</Link>
        </EmptyBlock>
      }
    >
      {(rows) => <DenseTable caption="Alert delivery log" columns={columns} rows={rows} rowKey={(row) => String(row.delivery_id)} />}
    </QueryBoundary>
  );

  return (
    <>
      <div className={styles.filters}>
        <label className={styles.field}>
          Status
          <select className={styles.control} value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All</option>
            {LOG_STATUSES.map((item) => <option key={item} value={item}>{deliveryLabel(item)}</option>)}
          </select>
        </label>
      </div>
      {body}
    </>
  );
}
