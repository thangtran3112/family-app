"use client";

import { useState } from "react";
import { TodayWatchlist, type TodaySelection } from "./Watchlist.tsx";
import { AlertsPanel } from "./AlertsPanel.tsx";
import { DeskRead } from "./DeskRead.tsx";
import { PriceChart } from "./PriceChart.tsx";
import { SignalFeed } from "./SignalFeed.tsx";
import styles from "./today.module.css";

export function TodayDashboard() {
  const [selected, setSelected] = useState<TodaySelection | null>(null);

  return (
    <div className={styles.dashboard}>
      <header className={styles.dashboardHeading}>
        <div>
          <p className={styles.eyebrow}>MARKET OVERVIEW</p>
          <h1>Today</h1>
        </div>
        <a className={styles.primaryLink} href="/strategies/new">New strategy</a>
      </header>
      <div className={`${styles.dashboardGrid} ${selected ? styles.dashboardGridWithChart : styles.dashboardGridWithoutChart}`}>
        <TodayWatchlist selected={selected} onSelect={setSelected} />
        {selected && (
          <PriceChart
            key={`${selected.asset_type}:${selected.symbol}`}
            symbol={selected.symbol}
            assetType={selected.asset_type}
          />
        )}
        <aside className={styles.rail} aria-label="Desk updates">
          <SignalFeed />
          <AlertsPanel />
          <DeskRead />
        </aside>
      </div>
    </div>
  );
}
