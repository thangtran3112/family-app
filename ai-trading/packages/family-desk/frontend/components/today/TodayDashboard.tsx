import { TodayWatchlist } from "./Watchlist.tsx";
import { AlertsPanel } from "./AlertsPanel.tsx";
import { DeskRead } from "./DeskRead.tsx";
import { SignalFeed } from "./SignalFeed.tsx";
import styles from "./today.module.css";

export function TodayDashboard() {
  return (
    <main className={styles.dashboard}>
      <header className={styles.dashboardHeading}>
        <div>
          <p className={styles.eyebrow}>MARKET OVERVIEW</p>
          <h1>Today</h1>
        </div>
        <a className={styles.primaryLink} href="/strategies/new">New strategy</a>
      </header>
      <div className={styles.dashboardGrid}>
        <TodayWatchlist />
        <SignalFeed />
        <aside className={styles.rail} aria-label="Desk updates">
          <AlertsPanel />
          <DeskRead />
        </aside>
      </div>
    </main>
  );
}
