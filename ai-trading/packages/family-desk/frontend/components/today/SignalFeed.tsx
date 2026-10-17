"use client";

import { useEffect, useState } from "react";
import type { z } from "zod";
import { deskFetch } from "../../lib/api/client.ts";
import { SignalsResponseSchema, SignalOutSchema } from "../../lib/api/schemas.ts";
import { formatAsOf } from "../../lib/today.ts";
import styles from "./today.module.css";

type Signal = z.infer<typeof SignalOutSchema>;

export function SignalFeed() {
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    deskFetch("/api/desk/signals?limit=50", SignalsResponseSchema)
      .then((items) => {
        if (active) setSignals(items);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className={styles.panel} aria-labelledby="signal-feed-title" aria-busy={signals === null && !error}>
      <header className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>ACTIVITY</p>
          <h2 id="signal-feed-title">Signals</h2>
        </div>
        {signals && <span className={styles.muted}>{signals.length} latest</span>}
      </header>
      {error ? (
        <p className={styles.error} role="alert">Signals could not be loaded. Try again later.</p>
      ) : signals === null ? (
        <p className={styles.muted} role="status">Loading signals…</p>
      ) : signals.length === 0 ? (
        <p className={styles.empty}>No signals recorded yet.</p>
      ) : (
        <ol className={styles.signalList}>
          {signals.map((signal) => (
            <li className={styles.signalItem} key={signal.id}>
              <div className={styles.signalMeta}>
                <strong>{signal.symbol}</strong>
                <span className={styles.quality}>{signal.data_quality}</span>
                <time dateTime={signal.created_at}>{formatAsOf(signal.created_at)}</time>
              </div>
              <p>Signal from strategy version {signal.strategy_version_id}</p>
              <span className={styles.muted}>Bar · {formatAsOf(signal.bar_time)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
