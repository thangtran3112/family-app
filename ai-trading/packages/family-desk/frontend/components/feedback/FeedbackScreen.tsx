"use client";

import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { Button } from "@/components/ui/Button";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadFeedback } from "@/lib/desk/feedback";
import { countsText, defaultFilters, listFootnote, toQuery, totalOf, type FeedbackFilters as Filters } from "@/lib/desk/feedbackView";
import { reportUrl } from "@/lib/desk/feedbackContext";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { FeedbackDetailRail } from "./FeedbackDetailRail";
import { FeedbackFilters } from "./FeedbackFilters";
import { FeedbackTable } from "./FeedbackTable";
import styles from "./feedback.module.css";

/** `?id=14` -> 14; anything else is no selection. */
export function reportIdFromParam(raw: string | null): number | null {
  const id = Number(raw);
  return raw !== null && Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * `/feedback` (02s): the log of bugs and feature requests with their status, and the selected report in the right rail.
 * The detail is `?id=` on this route, because the Desk is a static export. Reads the URL, so the page wraps it in Suspense.
 */
export function FeedbackScreen() {
  const selectedId = reportIdFromParam(useSearchParams().get("id"));
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  // Bumped by "Clear filters": the filter bar keeps its own search text, so it remounts to forget it.
  const [resets, setResets] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const query = toQuery(filters);
  const list = useDeskQuery(`feedback:${JSON.stringify(query)}`, (signal) => loadFeedback(query, { signal }), { intervalMs: 60_000 });
  const counts = list.data?.counts ?? null;
  const total = counts ? totalOf(counts) : 0;
  const empty = counts !== null && total === 0;

  function select(id: number) {
    // The address carries the selection (`/feedback?id=14`), so a reload or a pasted link opens the same report.
    window.history.replaceState(null, "", `/feedback?id=${id}`);
    setDrawerOpen(true);
  }

  function clearFilters() {
    setFilters(defaultFilters());
    setResets((count) => count + 1);
  }

  let body: ReactNode;
  if (list.data === null) {
    body = list.error === null ? <LoadingBlock label="Loading reports…" /> : <ErrorBlock subject="report list" onRetry={list.refresh} />;
  } else if (empty) {
    body = (
      <EmptyBlock
        title="No reports yet · file one when something looks wrong, or when you want something built"
        action={{ label: "New report", href: reportUrl("/feedback") }}
      />
    );
  } else if (list.data.items.length === 0) {
    body = (
      <EmptyBlock title="No reports match these filters">
        <Button onClick={clearFilters}>Clear filters</Button>
      </EmptyBlock>
    );
  } else {
    body = (
      <>
        <FeedbackTable items={list.data.items} selectedId={selectedId} onSelect={select} />
        <p className={styles.footnote}>
          {listFootnote(list.data.items.length, total)} · Hover a row for Open and Copy id · A Fixed report always shows its fix commit or pull request.
        </p>
      </>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.top}>
        <div className={styles.titleRow}>
          <div className={styles.titleGroup}>
            <h1 className={styles.title}>Feedback</h1>
            {counts && <p className={styles.counts}>{countsText(counts)}</p>}
          </div>
          <Button client href={reportUrl("/feedback")} variant="primary">New report</Button>
        </div>
        <FeedbackFilters key={resets} value={filters} onChange={setFilters} items={list.data?.items ?? []} disabled={empty} />
      </div>
      <div className={list.data !== null && !empty && list.data.items.length > 0 ? undefined : styles.stateBody}>{body}</div>
      <RightRail
        label="Report details"
        sections={[{ id: "detail", label: "Report", node: <FeedbackDetailRail id={selectedId} /> }]}
        openId={drawerOpen ? "detail" : null}
        onOpenChange={(id) => setDrawerOpen(id === "detail")}
      />
    </div>
  );
}
