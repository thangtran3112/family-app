"use client";

import { useDeskStatus } from "@/components/shell/desktop/DeskContext";
import { Button } from "@/components/ui/Button";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { formatEtTime } from "@/lib/desk/format";
import { symbolHref } from "@/lib/desk/listNav";
import { loadAlertInbox, markAlertRead, markAllAlertsRead } from "@/lib/desk/status";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "./dashboard.module.css";

/** The dashboard's right-rail alerts feed. Marking read refreshes the bell's unread count too. */
export function AlertsFeed() {
  const { refresh: refreshStatus } = useDeskStatus();
  const alerts = useDeskQuery("dashboard-alerts", (signal) => loadAlertInbox({ limit: 20 }, { signal }), { intervalMs: 60_000 });

  async function markRead(id: number) {
    await markAlertRead(id).catch(() => undefined);
    refreshStatus();
    alerts.refresh();
  }

  async function markAll() {
    await markAllAlertsRead().catch(() => undefined);
    refreshStatus();
    alerts.refresh();
  }

  if (alerts.data === null) {
    return alerts.error ? <ErrorBlock subject="alert list" onRetry={alerts.refresh} /> : <LoadingBlock label="Loading alerts…" height={120} />;
  }
  if (alerts.data.length === 0) return <EmptyBlock title="No alerts yet" />;

  return (
    <>
      <div className={styles.feedHead}>
        <Button size="md" onClick={markAll}>Mark all read</Button>
      </div>
      <ul className={styles.feed}>
        {alerts.data.map((alert) => {
          const unread = alert.read_at === null;
          return (
            <li key={alert.id} className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.dot} data-unread={unread ? "true" : undefined} aria-hidden="true" />
                {unread && <span className="sr-only">Unread</span>}
                <span className={styles.itemTitle}>{alert.title}</span>
                <span className={styles.muted}>{formatEtTime(alert.created_at)}</span>
              </div>
              <p className={styles.itemBody}>{alert.body}</p>
              <div className={styles.itemFoot}>
                {alert.symbol && <a className={styles.link} href={symbolHref(alert.symbol)}>{alert.symbol}</a>}
                {unread && <Button size="md" onClick={() => markRead(alert.id)}>Mark read</Button>}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
