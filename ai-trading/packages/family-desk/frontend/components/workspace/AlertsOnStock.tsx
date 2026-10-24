"use client";

import type { ReactNode } from "react";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { AlertStrategy } from "@/lib/api/schemas";
import { formatEtStamp } from "@/lib/desk/format";
import styles from "./workspacePanels.module.css";

const SHOWN = 5;

export function AlertsOnStock({
  symbol,
  strategies,
  failed,
  onRetry,
}: {
  symbol: string;
  strategies: AlertStrategy[] | null;
  failed: boolean;
  onRetry: () => void;
}) {
  const encoded = encodeURIComponent(symbol);
  const addAlert = <a href={`/alerts/new?source=symbol:${encoded}`} className={styles.link}>+ Alert</a>;

  let body: ReactNode;
  if (failed) {
    body = <ErrorBlock subject="alert list" onRetry={onRetry} />;
  } else if (strategies === null) {
    body = <LoadingBlock label="Loading alerts…" height={60} />;
  } else if (strategies.length === 0) {
    body = <p className={styles.muted}>No alerts on {symbol} yet</p>;
  } else {
    body = (
      <>
        <ul className={styles.list}>
          {strategies.slice(0, SHOWN).map((row) => (
            <li key={row.id} className={`${styles.listRow} ${styles.alertRow}`}>
              <span className={styles.ellipsis} title={row.name}>{row.name}</span>
              <span className={styles.muted}>{row.status}</span>
              <span className={styles.muted}>{row.last_fired_at === null ? "Never fired" : formatEtStamp(row.last_fired_at)}</span>
            </li>
          ))}
        </ul>
        {strategies.length > SHOWN && <a href={`/alerts?symbol=${encoded}`} className={styles.link}>View all</a>}
      </>
    );
  }

  return (
    <section className={styles.section} aria-label={`Alerts on ${symbol}`}>
      <header className={styles.sectionHead}>
        <h3 className={styles.heading}>Alerts on {symbol}{strategies && ` · ${strategies.length}`}</h3>
        {addAlert}
      </header>
      {body}
    </section>
  );
}
