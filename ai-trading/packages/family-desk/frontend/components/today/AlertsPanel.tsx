"use client";

import { useEffect, useState } from "react";
import type { z } from "zod";
import { deskFetch } from "../../lib/api/client.ts";
import { AlertOutSchema, AlertsResponseSchema } from "../../lib/api/schemas.ts";
import { formatAsOf, markAlertRead } from "../../lib/today.ts";
import styles from "./today.module.css";

type Alert = z.infer<typeof AlertOutSchema>;

export function AlertsPanel() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    deskFetch("/api/desk/alerts", AlertsResponseSchema)
      .then((items) => {
        if (active) setAlerts(items);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  async function markRead(id: number) {
    if (pendingId !== null) return;
    setPendingId(id);
    setActionError(null);
    try {
      const updated = await markAlertRead(id);
      setAlerts((items) => items?.map((item) => item.id === id ? updated : item) ?? null);
    } catch {
      setActionError("Alert could not be marked read. Try again.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="alerts-title" aria-busy={alerts === null && !loadError}>
      <header className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>INBOX</p>
          <h2 id="alerts-title">Alerts</h2>
        </div>
        {alerts && <span className={styles.muted}>{alerts.filter((item) => item.read_at === null).length} unread</span>}
      </header>
      {loadError ? (
        <p className={styles.error} role="alert">Alerts could not be loaded. Try again later.</p>
      ) : alerts === null ? (
        <p className={styles.muted} role="status">Loading alerts…</p>
      ) : alerts.length === 0 ? (
        <p className={styles.empty}>No alerts yet.</p>
      ) : (
        <ol className={styles.alertList}>
          {alerts.slice(0, 8).map((alert) => (
            <li className={styles.alertItem} key={alert.id}>
              <div className={styles.alertMeta}>
                <span className={alert.read_at === null ? styles.unreadDot : styles.readDot} aria-hidden="true" />
                <span className={styles.alertKind}>{alert.kind} · {alert.severity}</span>
                <time dateTime={alert.created_at}>{formatAsOf(alert.created_at)}</time>
              </div>
              <h3>{alert.title}</h3>
              <p>{alert.body}</p>
              {alert.read_at === null && (
                <button
                  className={styles.secondaryButton}
                  type="button"
                  disabled={pendingId !== null}
                  onClick={() => void markRead(alert.id)}
                >
                  {pendingId === alert.id ? "Saving…" : "Mark read"}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {actionError && <p className={styles.error} role="alert">{actionError}</p>}
    </section>
  );
}
