"use client";

import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Freshness, useFreshness } from "@/components/ui/Freshness";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadDashboard } from "@/lib/desk/dashboard";
import { alertsBanner, COPY } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { AlertsFeed } from "./AlertsFeed";
import { EventsPanel } from "./EventsPanel";
import { MarketStrip } from "./MarketStrip";
import { ScreenerMatchCards } from "./ScreenerMatchCards";
import { SignalsPanel } from "./SignalsPanel";
import { WatchlistHeat } from "./WatchlistHeat";
import styles from "./dashboard.module.css";

/** Today (D2): market strip, signals and screener cards, watchlist heat, events, and the alerts rail. */
export function DashboardScreen() {
  const { selectedListId } = useDeskUi();
  const query = useDeskQuery(`dashboard:${selectedListId ?? "default"}`, (signal) => loadDashboard(selectedListId ?? undefined, { signal }), { intervalMs: 60_000 });
  const data = query.data;
  const connection = query.connection === "reconnecting" ? "reconnecting" : "ok";
  // One verdict for the badge, the dim and the stale mark: a paused feed dims the prices and marks the tiles (V-Today-01).
  const fresh = useFreshness({ stamp: data?.stamp ?? null, session: data?.market.session, connection, feed: true });
  const dim = fresh.stale;
  const banner = data ? alertsBanner(data.alerts_state) : null;

  return (
    <div className={styles.screen}>
      <header className={styles.head}>
        <h1 className={styles.pageTitle}>Today</h1>
        {/* "Updating" shows in the caption below; the badge keeps showing the data's own state. */}
        {data && <Freshness stamp={data.stamp} session={data.market.session} connection={connection} feed />}
        {query.updating && <span className={styles.caption}>{COPY.updating}</span>}
        <Button size="md" onClick={query.refresh}>Refresh</Button>
      </header>
      {banner && <Banner>{banner}</Banner>}
      {data ? (
        <>
          <MarketStrip strip={data.market_strip} nextUpdateAt={data.market.next_update_at ?? null} dim={dim} staleMark={fresh.mark} />
          <div className={`${styles.columns} ${dim ? styles.dim : ""}`}>
            <SignalsPanel signals={data.signals} />
            <ScreenerMatchCards matches={data.screener_matches} />
          </div>
          <WatchlistHeat watchlist={data.watchlist} dim={dim} />
          <div className={dim ? styles.dim : undefined}>
            <EventsPanel events={data.events} />
          </div>
        </>
      ) : query.error ? (
        <ErrorBlock subject="dashboard" onRetry={query.refresh} />
      ) : (
        <LoadingBlock label="Loading today…" height={320} />
      )}
      <RightRail sections={[{ id: "alerts", label: "Alerts", node: <AlertsFeed /> }]} label="Alerts feed" />
    </div>
  );
}
