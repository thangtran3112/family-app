"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDeskStatus, useDeskUi } from "@/components/shell/desktop/DeskContext";
import { Popover } from "@/components/ui/Popover";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { formatEtTime } from "@/lib/desk/format";
import { SYMBOL_HREF } from "@/lib/lanes";
import { loadAlertInbox, markAlertRead, markAllAlertsRead } from "@/lib/desk/status";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "./topbar.module.css";

type Alert = Awaited<ReturnType<typeof loadAlertInbox>>[number];

export function AlertsBell() {
  const router = useRouter();
  const { status, refresh: refreshStatus } = useDeskStatus();
  const { lane, confirmLeave } = useDeskUi();
  const [open, setOpen] = useState(false);
  const alerts = useDeskQuery("bell-alerts", (signal) => loadAlertInbox({ limit: 8 }, { signal }), { enabled: open });
  const unread = status?.alerts.unread ?? 0;

  async function openAlert(alert: Alert) {
    await markAlertRead(alert.id).catch(() => undefined);
    refreshStatus();
    // The bell shows in Technical and Fundamental; an alert opens that mode's symbol page (ADR-0014).
    const href = alert.symbol ? SYMBOL_HREF[lane]?.(alert.symbol) : undefined;
    if (href) {
      setOpen(false);
      if (confirmLeave()) router.push(href);
    } else {
      alerts.refresh();
    }
  }

  async function markAll() {
    await markAllAlertsRead().catch(() => undefined);
    refreshStatus();
    alerts.refresh();
  }

  function body() {
    if (alerts.data === null) {
      return alerts.error ? <ErrorBlock subject="alert list" onRetry={alerts.refresh} /> : <LoadingBlock label="Loading alerts…" />;
    }
    if (alerts.data.length === 0) return <EmptyBlock title="No alerts yet" />;
    return (
      <ul className={styles.alertList}>
        {alerts.data.map((alert) => (
          <li key={alert.id}>
            <button type="button" className={styles.alertRow} onClick={() => openAlert(alert)}>
              <span className={styles.dot} data-unread={alert.read_at === null ? "true" : undefined} aria-hidden="true" />
              <span className={styles.alertBody}>
                <span className={styles.alertTitle}>
                  {alert.read_at === null && <span className={styles.srOnly}>Unread: </span>}
                  {alert.title}
                </span>
                {alert.symbol && <span className={styles.alertMeta}>{alert.symbol}</span>}
              </span>
              <span className={styles.alertTime}>{formatEtTime(alert.created_at)}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      role="dialog"
      label="Recent alerts"
      width={360}
      trigger={(props) => (
        <button type="button" className={styles.iconButton} aria-label={unread > 0 ? `Alerts, ${unread} unread` : "Alerts"} {...props}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          {unread > 0 && <span className={styles.badge} aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
        </button>
      )}
    >
      <div className={styles.panelHead}>Recent alerts</div>
      {body()}
      <div className={styles.panelFoot}>
        <button type="button" className={styles.textButton} onClick={markAll}>Mark all read</button>
        <a className={styles.textButton} href="/alerts">View alerts</a>
      </div>
    </Popover>
  );
}
