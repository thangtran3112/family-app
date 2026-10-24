"use client";

import { useState } from "react";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { AlertLogRow } from "@/lib/api/schemas";
import { loadAlertLog } from "@/lib/desk/alerts";
import { LOG_STATUSES, logRowText } from "@/lib/desk/alertsView";
import { channelLabel, deliveryLabel } from "@/lib/desk/labels";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "./alerts.module.css";

/** Delivered is up, a hold or no channel is amber, a failure is down. */
export const deliveryTone = (status: string) => (status === "delivered" ? "up" : status === "failed" ? "down" : "amber");

const columns: DenseColumn<AlertLogRow>[] = [
  { key: "when", label: "Time", render: (row) => logRowText(row).when },
  { key: "what", label: "Alert", render: (row) => logRowText(row).what },
  { key: "channel", label: "Channel", render: (row) => channelLabel(row.channel) },
  { key: "result", label: "Result", render: (row) => <span className={styles.chip} data-tone={deliveryTone(row.status)}>{deliveryLabel(row.status)}</span> },
  { key: "detail", label: "Detail", render: (row) => <span className={styles.clip} title={row.detail}>{row.detail}</span> },
];

/** Log tab of D9: every delivery attempt, newest first (02m §a3.7). */
export function AlertLog() {
  const [status, setStatus] = useState("");
  const log = useDeskQuery(
    `alert-log:${status}`,
    (signal) => loadAlertLog({ status: status || undefined, limit: 50 }, { signal }),
    { intervalMs: 60_000 },
  );

  let body;
  if (log.data === null) {
    body = log.error === null ? <LoadingBlock label="Loading delivery log…" /> : <ErrorBlock subject="delivery log" onRetry={log.refresh} />;
  } else if (log.data.length === 0) {
    body = <EmptyBlock title="Nothing delivered yet" />;
  } else {
    body = <DenseTable caption="Alert delivery log" columns={columns} rows={log.data} rowKey={(row) => String(row.delivery_id)} />;
  }

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
