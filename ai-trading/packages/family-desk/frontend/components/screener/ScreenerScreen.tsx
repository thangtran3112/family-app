"use client";

import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useDeskStatus } from "@/components/shell/desktop/DeskContext";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { COPY, emptyScanText } from "@/lib/desk/freshness";
import { loadFilterDetail, loadFilterResults, loadFilters, type ScreenerSession } from "@/lib/desk/screener";
import { filterIdFromParam, pickFilter, resultsState, scanIsDelayed } from "@/lib/desk/screenerView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { FilterHeader } from "./FilterHeader";
import { PreviewPane } from "./PreviewPane";
import { ResultsTable } from "./ResultsTable";
import { UniverseLine } from "./UniverseLine";
import styles from "./screener.module.css";

/** D5 (02l): filter header, universe line and results table in the centre; the chart preview in the right rail. */
export function ScreenerScreen() {
  const { status } = useDeskStatus();
  const requested = filterIdFromParam(useSearchParams().get("filter"));
  const filters = useDeskQuery("screener-filters", (signal) => loadFilters({ signal }));
  const filter = filters.data ? pickFilter(filters.data, requested) : null;
  const id = filter?.id ?? null;

  // A Regular/Extended override belongs to one filter; another filter falls back to its own session.
  const [sessionPick, setSessionPick] = useState<{ id: number; session: ScreenerSession } | null>(null);
  const session = sessionPick && sessionPick.id === id ? sessionPick.session : (filter?.session ?? "regular");

  const detail = useDeskQuery(`filter-detail:${id}`, (signal) => loadFilterDetail(id!, { signal }), { enabled: id !== null });
  const results = useDeskQuery(`filter-results:${id}:${session}`, (signal) => loadFilterResults(id!, session, { signal }), {
    intervalMs: 60_000,
    enabled: id !== null,
  });
  const data = results.data;
  const delayed = data !== null && scanIsDelayed(data.stamp);

  const [picked, setPicked] = useState<string | null>(null);
  const firstSymbol = data?.matches[0]?.symbol ?? null;
  const selectedSymbol = data?.matches.some((match) => match.symbol === picked) ? picked : firstSymbol;
  const state = resultsState({
    loading: results.loading,
    hasResults: data !== null,
    failed: results.error !== null && data === null,
    matches: data?.matches.length ?? 0,
  });

  let body: ReactNode;
  if (filters.data === null) {
    body = filters.error === null ? <LoadingBlock label="Loading filters…" height={240} /> : <ErrorBlock subject="filter list" onRetry={filters.refresh} />;
  } else if (filter === null) {
    body = <EmptyBlock title="No screener filters yet" />;
  } else {
    let table: ReactNode;
    if (state === "scanning") table = <LoadingBlock label={COPY.scanning} height={240} />;
    else if (state === "error") table = <ErrorBlock subject="scan results" onRetry={results.refresh} />;
    else if (state === "empty") table = <EmptyBlock title={emptyScanText(status?.scans.next_run_at ?? null)} />;
    else if (data) {
      table = (
        <ResultsTable results={data} selected={selectedSymbol} onSelect={(symbol) => setPicked(symbol)} dim={results.connection === "reconnecting"} />
      );
    }

    body = (
      <>
        <FilterHeader key={filter.id}
          filter={filter}
          detail={detail.data}
          session={session}
          onSession={(next) => setSessionPick({ id: filter.id, session: next })}
          delayed={delayed}
        />
        <div className={styles.meta}>
          <UniverseLine />
          {/* A delayed scan shows its pill by the title instead; the badge still shows if the connection is in trouble. */}
          {data && (!delayed || results.connection !== "ok") && <FreshnessBadge stamp={data.stamp} connection={results.connection} />}
        </div>
        {table}
        <RightRail sections={[{ id: "preview", label: "Preview", node: <PreviewPane symbol={selectedSymbol} runOn={filter.run_on} /> }]} label="Chart preview" />
      </>
    );
  }

  return <div className={styles.screen}>{body}</div>;
}
