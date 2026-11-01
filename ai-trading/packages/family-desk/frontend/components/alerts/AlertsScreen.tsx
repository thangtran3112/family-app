"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useDeskStatus } from "@/components/shell/desktop/DeskContext";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { TabPanel, Tabs } from "@/components/ui/Tabs";
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
          <Button onClick={() => setFilters(defaultAlertFilters())}>Clear filters</Button>
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
        <Button variant="primary" href="/alerts/new" client>New alert strategy</Button>
      </header>
      <Tabs idBase="alerts-views" label="Alerts views" tabs={TABS} value={tab} onChange={setTab} className={styles.tabs} />
      <TabPanel idBase="alerts-views" id={tab} className={styles.body}>
        {banner && <Banner>{banner}</Banner>}
        {tab === "list" ? (
          <>
            <AlertFilters value={filters} onChange={setFilters} />
            {body}
          </>
        ) : (
          <AlertLog />
        )}
      </TabPanel>
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
