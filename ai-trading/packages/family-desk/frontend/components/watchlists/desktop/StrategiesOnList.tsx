"use client";

import { PanelHeader } from "@/components/ui/Panel";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadAlertStrategies } from "@/lib/desk/alerts";
import { formatEtStamp } from "@/lib/desk/format";
import { statusLabel } from "@/lib/desk/labels";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "./watchlistDesktop.module.css";

/** Right-rail section: the alert strategies that watch this list (02m §a3.5, D7). */
export function StrategiesOnList({ listId, listName }: { listId: number; listName: string }) {
  const strategies = useDeskQuery(`list-strategies:${listId}`, (signal) => loadAlertStrategies({ watchlistId: listId }, { signal }));

  let body;
  if (strategies.data === null) {
    body = strategies.error === null
      ? <LoadingBlock label="Loading strategies…" height={60} />
      : <ErrorBlock subject="strategy list" onRetry={strategies.refresh} />;
  } else if (strategies.data.length === 0) {
    body = <p className={styles.muted}>No strategies on this list yet</p>;
  } else {
    body = (
      <ul className={styles.rows}>
        {strategies.data.map((row) => (
          <li key={row.id} className={styles.strategyRow}>
            <span className={styles.ellipsis} title={row.name}>{row.name}</span>
            <span className={styles.muted}>{statusLabel(row.status)}</span>
            <span className={styles.muted}>{row.last_fired_at === null ? "Never fired" : formatEtStamp(row.last_fired_at)}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className={styles.strategies}>
      <PanelHeader variant="label" level={3} title={`Strategies on ${listName}`} />
      <div className={styles.links}>
        <a href={`/strategies/library?watchlist=${listId}`} className={styles.link}>Add preset</a>
        <a href={`/alerts/new?source=watchlist:${listId}`} className={styles.link}>New alert strategy</a>
      </div>
      {body}
    </div>
  );
}
