"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useDeskStatus } from "@/components/shell/desktop/DeskContext";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadAlertStrategies } from "@/lib/desk/alerts";
import { defaultAlertFilters, toQuery, type AlertFilterState, type AlertsTab } from "@/lib/desk/alertsView";
import { alertsBanner, COPY } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { AlertDetailPane } from "./AlertDetailPane";
import { AlertFilters } from "./AlertFilters";
import { AlertLog } from "./AlertLog";
import { AlertTable } from "./AlertTable";
import styles from "./alerts.module.css";

const TABS: readonly { id: AlertsTab; label: string }[] = [
  { id: "list", label: "List" },
  { id: "log", label: "Log" },
];

/** D9 Alerts (02m §a3.7, §c2): the strategy list with its detail rail, and the delivery Log. Reads the URL, so the page wraps it in Suspense. */
export function AlertsScreen() {
  const searchParams = useSearchParams();
  const { status } = useDeskStatus();
  const [tab, setTab] = useState<AlertsTab>("list");
  const [filters, setFilters] = useState<AlertFilterState>(() => ({ ...defaultAlertFilters(), symbol: searchParams.get("symbol") ?? "" }));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const query = toQuery(filters);
  const list = useDeskQuery(`alert-strategies:${JSON.stringify(query)}`, (signal) => loadAlertStrategies(query, { signal }), { intervalMs: 60_000 });
  const banner = status ? alertsBanner(status.alerts.state) : null;
  const filtersActive = Boolean(query.status || query.category || query.symbol);

  let body: ReactNode;
  if (list.data === null) {
    body = list.error === null ? <LoadingBlock label="Loading alert strategies…" /> : <ErrorBlock subject="alert list" onRetry={list.refresh} />;
  } else if (list.data.length === 0) {
    body = filtersActive
      ? (
        <EmptyBlock title="No alert strategies match these filters">
          <button type="button" className={styles.button} onClick={() => setFilters(defaultAlertFilters())}>Clear filters</button>
        </EmptyBlock>
      )
      : (
        <EmptyBlock title={COPY.noAlertStrategies}>
          <Link href="/alerts/new" className={styles.link}>New alert strategy</Link>
        </EmptyBlock>
      );
  } else {
    body = (
      <AlertTable
        rows={list.data}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setDrawerOpen(true);
        }}
        onChanged={list.refresh}
      />
    );
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Alerts</h1>
        <Link href="/alerts/new" className={`${styles.button} ${styles.primary}`}>New alert strategy</Link>
      </header>
      <div role="tablist" aria-label="Alerts views" className={styles.tabs}>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={styles.tab}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className={styles.body}>
        {banner && <p role="status" className={styles.banner}>{banner}</p>}
        {tab === "list" ? (
          <>
            <AlertFilters value={filters} onChange={setFilters} />
            {body}
          </>
        ) : (
          <AlertLog />
        )}
      </div>
      {tab === "list" && (
        <RightRail
          label="Alert details"
          sections={[{ id: "detail", label: "Details", node: <AlertDetailPane id={selectedId} onChanged={list.refresh} /> }]}
          openId={drawerOpen ? "detail" : null}
          onOpenChange={(id) => setDrawerOpen(id === "detail")}
        />
      )}
    </div>
  );
}
