"use client";

import { useEffect, useState } from "react";
import { deskFetch } from "../../lib/api/client.ts";
import { gatewayLine } from "../../lib/desk/gateway.ts";
import { StatusSchema } from "../../lib/api/schemas.ts";
import styles from "./Settings.module.css";

type DeskStatus = ReturnType<typeof StatusSchema.parse>;

export function SourcesStatus() {
  const [status, setStatus] = useState<DeskStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  async function loadStatus() {
    setLoading(true);
    setError(false);
    try {
      setStatus(await deskFetch("/api/desk/status", StatusSchema));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void deskFetch("/api/desk/status", StatusSchema)
      .then((value) => { if (active) setStatus(value); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <aside className={styles.status} aria-labelledby="system-status-title" aria-busy={loading}>
      <h2 id="system-status-title" className={styles.eyebrow}>System status</h2>
      {loading && <p className={styles.statusNote}>Loading current status…</p>}
      {error && (
        <div className={styles.statusError} role="alert">
          <p>Status could not be loaded.</p>
          <button className={styles.retryButton} type="button" onClick={() => void loadStatus()} disabled={loading}>Retry</button>
        </div>
      )}
      {status && (
        <dl className={styles.statusList}>
          <div className={styles.statusItem}>
            <dt>IBKR gateway</dt>
            <dd>{gatewayLine(status.gateway)}</dd>
          </div>
          <div className={styles.statusItem}>
            <dt>Streaming slots</dt>
            <dd>{status.streaming_slots.used} / {status.streaming_slots.max} used</dd>
          </div>
          <div className={styles.statusItem}>
            <dt>Backups</dt>
            <dd>{status.backups === null ? "No feed yet" : "Available"}</dd>
          </div>
          <div className={styles.statusItem}>
            <dt>Paper reconciliation</dt>
            <dd>{status.reconciliation === null ? "No feed yet" : "Available"}</dd>
          </div>
        </dl>
      )}
    </aside>
  );
}
