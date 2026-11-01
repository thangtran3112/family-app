"use client";

import { PanelHeader } from "@/components/ui/Panel";
import { RailList, RailValue } from "@/components/ui/RailList";
import { QueryBoundary } from "@/components/ui/StateBlocks";
import { loadAlertStrategies } from "@/lib/desk/alerts";
import { formatEtStamp } from "@/lib/desk/format";
import { strategyHref } from "@/lib/desk/hrefs";
import { statusLabel } from "@/lib/desk/labels";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "./watchlistDesktop.module.css";
import { alertNewHref } from "@/lib/desk/hrefs";

/** Right-rail section: the alert strategies that watch this list (02m §a3.5, D7). */
export function StrategiesOnList({ listId, listName }: { listId: number; listName: string }) {
  const strategies = useDeskQuery(`list-strategies:${listId}`, (signal) => loadAlertStrategies({ watchlistId: listId }, { signal }));

  const body = (
    <QueryBoundary
      query={strategies}
      loading="Loading strategies…"
      height={60}
      subject="strategy list"
      isEmpty={(rows) => rows.length === 0}
      empty={<p className={styles.muted}>No strategies on this list yet</p>}
    >
      {(rows) => (
      <RailList
        size="md"
        divided
        rows={rows.map((row) => ({
          id: String(row.id),
          href: strategyHref(row.id),
          label: row.name,
          value: (
            <RailValue>
              <span>{statusLabel(row.status)}</span> <span>{row.last_fired_at === null ? "Never fired" : formatEtStamp(row.last_fired_at)}</span>
            </RailValue>
          ),
        }))}
      />
      )}
    </QueryBoundary>
  );

  return (
    <div className={styles.strategies}>
      <PanelHeader variant="label" level={3} title={`Strategies on ${listName}`} />
      <div className={styles.links}>
        <a href={`/strategies/library?watchlist=${listId}`} className={styles.link}>Add preset</a>
        <a href={alertNewHref({ watchlist: listId })} className={styles.link}>New alert strategy</a>
      </div>
      {body}
    </div>
  );
}
