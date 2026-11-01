"use client";

import { useState } from "react";
import { DeskAiNotStarted } from "@/components/fundamental/shared/DeskAiNotStarted";
import type { TimelineItem } from "@/lib/api/fundamentalSchemas";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadTimeline } from "@/lib/desk/research";
import { TIMELINE_FILTERS, TIMELINE_PAGE, timelineHasMore, timelineRows, type TimelineFilterId } from "@/lib/desk/researchView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "../fundamental.module.css";
import local from "./stocks.module.css";

/** FD10 Timeline (02n §b3): earnings, consensus, filings, news and Desk AI items for one stock, newest first. */
export function StockTimeline({ symbol }: { symbol: string }) {
  const [filter, setFilter] = useState<TimelineFilterId>("all");
  return (
    <div data-testid="fund-timeline">
      <Panel aria-label="Timeline">
        <PanelHeader title="Timeline" />
        <div className={local.chips} role="group" aria-label="Timeline filter">
          {TIMELINE_FILTERS.map((item) => (
            <Button key={item.id} size="md" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)} data-testid={`fund-timeline-filter-${item.id}`}>
              {item.label}
            </Button>
          ))}
        </div>
        <TimelineList key={`${symbol}:${filter}`} symbol={symbol} filter={filter} />
      </Panel>
    </div>
  );
}

function TimelineList({ symbol, filter }: { symbol: string; filter: TimelineFilterId }) {
  const kind = TIMELINE_FILTERS.find((item) => item.id === filter)?.kind;
  const first = useDeskQuery(`timeline:${symbol}:${filter}`, (signal) => loadTimeline(symbol, { kind, limit: TIMELINE_PAGE, offset: 0 }, { signal }));
  const [more, setMore] = useState<TimelineItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  if (first.error !== null && first.data === null) return <ErrorBlock subject="timeline" onRetry={first.refresh} />;
  if (first.data === null) return <LoadingBlock label="Loading the timeline…" height={160} />;

  const items = [...first.data.items, ...more];
  const rows = timelineRows(items);

  async function showMore() {
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await loadTimeline(symbol, { kind, limit: TIMELINE_PAGE, offset: items.length });
      setMore((current) => [...current, ...page.items]);
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  if (rows.length === 0) {
    // The Desk AI filter before the first run is the not-started state, not an empty list.
    return filter === "desk_ai" ? <DeskAiNotStarted title="Desk AI" /> : <p className={styles.muted}>Nothing on this timeline yet</p>;
  }
  return (
    <>
      <div role="list" aria-label="Timeline items">
        {rows.map((row) => (
          <article key={row.key} className={local.item} role="listitem">
            <span>{row.when}</span>
            <span className={local.itemKind} data-ai={row.isAi ? "true" : undefined}>{row.kind}</span>
            <div className={local.itemBody}>
              <span className={local.itemTitle}>
                {row.link ? (
                  <a className={styles.link} href={row.link.href} {...(row.link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{row.title}</a>
                ) : (
                  row.title
                )}
              </span>
              <span className={local.itemDetail}>{row.detail}</span>
              <span className={local.itemSource}>{row.source}</span>
            </div>
          </article>
        ))}
      </div>
      {timelineHasMore(items.length, first.data.total) && (
        <div>
          <Button size="md" onClick={() => void showMore()} loading={loadingMore}>{loadingMore ? "Loading…" : "Show more"}</Button>
          {moreFailed && <span className={styles.caption}> Couldn&apos;t load more · Try again</span>}
        </div>
      )}
    </>
  );
}
