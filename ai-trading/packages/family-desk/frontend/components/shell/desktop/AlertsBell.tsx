"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDeskStatus, useDeskUi } from "@/components/shell/desktop/DeskContext";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Popover } from "@/components/ui/Popover";
import { EmptyBlock, QueryBoundary } from "@/components/ui/StateBlocks";
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
      const go = () => router.push(href);
      if (confirmLeave(go)) go();
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
    return (
      <QueryBoundary query={alerts} loading="Loading alerts…" subject="alert list" isEmpty={(rows) => rows.length === 0} empty={<EmptyBlock title="No alerts yet" />}>
        {(rows) => (
      <ul className={styles.alertList}>
        {rows.map((alert) => (
          <li key={alert.id}>
            <button type="button" className={styles.alertRow} onClick={() => openAlert(alert)}>
              <span className={styles.dot} data-unread={alert.read_at === null ? "true" : undefined} aria-hidden="true" />
              <span className={styles.alertBody}>
                <span className={styles.alertTitle}>
                  {alert.read_at === null && <span className="sr-only">Unread: </span>}
                  {alert.title}
                </span>
                {alert.symbol && <span className={styles.alertMeta}>{alert.symbol}</span>}
              </span>
              <span className={styles.alertTime}>{formatEtTime(alert.created_at)}</span>
            </button>
          </li>
        ))}
      </ul>
        )}
      </QueryBoundary>
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
        <Button variant="ghost" iconOnly aria-label={unread > 0 ? `Alerts, ${unread} unread` : "Alerts"} {...props}>
          <Icon name="bell" />
          {unread > 0 && <Badge count={unread} tone="warn" className={styles.bellCount} aria-hidden="true" />}
        </Button>
      )}
    >
      <div className={styles.panelHead}>Recent alerts</div>
      {body()}
      <div className={styles.panelFoot}>
        <Button variant="ghost" size="sm" onClick={markAll}>Mark all read</Button>
        <Button variant="ghost" size="sm" href="/alerts">View alerts</Button>
      </div>
    </Popover>
  );
}
