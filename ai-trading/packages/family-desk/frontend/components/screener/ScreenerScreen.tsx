"use client";

import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useDeskStatus, useDeskUi } from "@/components/shell/desktop/DeskContext";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { Banner } from "@/components/ui/Banner";
import { Freshness, useFreshness } from "@/components/ui/Freshness";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { COPY, emptyScanText } from "@/lib/desk/freshness";
import { loadFilterDetail, loadFilterResults, loadFilters } from "@/lib/desk/screener";
import {
  applyQuickFilters,
  filterIdFromParam,
  missingFilterNote,
  neverScanned,
  pickFilter,
  quickFiltersActive,
  resultsState,
  scanIsDelayed,
  type QuickPicks,
} from "@/lib/desk/screenerView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { FilterChips } from "./FilterChips";
import { FilterHeader } from "./FilterHeader";
import { PreviewPane } from "./PreviewPane";
import { QuickFilters } from "./QuickFilters";
import { ResultsTable } from "./ResultsTable";
import { UniverseLine } from "./UniverseLine";
import styles from "./screener.module.css";

/** D5 (02l): filter header, universe line and results table in the centre; the chart preview in the right rail. */
export function ScreenerScreen() {
  const { status } = useDeskStatus();
  const { revisions } = useDeskUi();
  const requested = filterIdFromParam(useSearchParams().get("filter"));
  // Keyed on the filters revision like the rail, so a delete or a save shows here without a reload (A-SCR-08).
  const filters = useDeskQuery("screener-filters", (signal) => loadFilters({ signal }), { revision: revisions.filters });
  const filter = filters.data ? pickFilter(filters.data, requested) : null;
  const missing = filters.data ? missingFilterNote(filters.data, requested) : null;
  const id = filter?.id ?? null;

  const detail = useDeskQuery(`filter-detail:${id}`, (signal) => loadFilterDetail(id!, { signal }), { enabled: id !== null });
  const results = useDeskQuery(`filter-results:${id}`, (signal) => loadFilterResults(id!, { signal }), {
    intervalMs: 60_000,
    enabled: id !== null,
  });
  const data = results.data;
  const delayed = data !== null && scanIsDelayed(data.stamp);
  // The scan's own age is on its rows; this badge is about quotes, so it reads the feed (V-SCR-01).
  const fresh = useFreshness({ stamp: data?.stamp ?? null, connection: results.connection });
  const waiting = data !== null && neverScanned(data.stamp);

  // Quick filters stay set across filters: a price band is hers, not one filter's.
  const [picks, setPicks] = useState<QuickPicks>({});
  const quick = quickFiltersActive(picks);
  const rows = data ? applyQuickFilters(data.matches, picks) : [];

  const [picked, setPicked] = useState<string | null>(null);
  const firstSymbol = rows[0]?.symbol ?? null;
  const selectedSymbol = rows.some((match) => match.symbol === picked) ? picked : firstSymbol;
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
    body = (
      <EmptyBlock title={COPY.noFilters}>
        <a href="/screener/filters" className={styles.link}>{COPY.newFilter}</a>
      </EmptyBlock>
    );
  } else {
    let table: ReactNode;
    if (waiting) table = <EmptyBlock title={COPY.firstScan} />;
    // It reads the newest stored run; no scan runs because the page opened (V-SCR-14).
    else if (state === "scanning") table = <LoadingBlock label="Loading the latest scan…" height={240} />;
    else if (state === "error") table = <ErrorBlock subject="scan table" onRetry={results.refresh} />;
    else if (state === "empty") table = <EmptyBlock title={emptyScanText(status?.scans.next_run_at ?? null)} />;
    else if (data && rows.length === 0) {
      table = (
        <EmptyBlock title={`None of the ${data.matches_returned} rows pass your quick filters`}>
          <button type="button" className={styles.link} onClick={() => setPicks({})}>Clear quick filters</button>
        </EmptyBlock>
      );
    } else if (data) {
      table = (
        <ResultsTable
          results={data}
          rows={rows}
          quick={quick}
          selected={selectedSymbol}
          onSelect={(symbol) => setPicked(symbol)}
          dim={fresh.stale}
        />
      );
    }

    body = (
      <>
        <FilterChips filters={filters.data} activeId={filter.id} />
        {missing && <Banner>{missing}</Banner>}
        <FilterHeader key={filter.id} filter={filter} detail={detail.data} delayed={delayed} />
        <div className={styles.meta}>
          <UniverseLine run={data && !waiting ? data : null} />
          {/* A delayed scan shows its pill by the title instead; the badge still shows if the connection is in trouble. */}
          {data && !waiting && (!delayed || results.connection !== "ok" || fresh.stale) && <Freshness stamp={data.stamp} connection={results.connection} />}
        </div>
        {data && data.matches.length > 0 && <QuickFilters picks={picks} onChange={setPicks} />}
        {table}
        <RightRail sections={[{ id: "preview", label: "Preview", node: <PreviewPane symbol={selectedSymbol} runOn={filter.run_on} /> }]} label="Chart preview" />
      </>
    );
  }

  return <div className={styles.screen}>{body}</div>;
}
