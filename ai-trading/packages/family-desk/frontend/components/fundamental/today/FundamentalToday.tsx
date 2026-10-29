"use client";

import { useState } from "react";
import Link from "next/link";
import { MarketStrip } from "@/components/dashboard/MarketStrip";
import { FundamentalRightRail } from "@/components/fundamental/rail/FundamentalRightRail";
import { useDeskStatus, useDeskUi, useHoldings } from "@/components/shell/desktop/DeskContext";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadShortCalls, loadIncome } from "@/lib/desk/coveredCalls";
import { loadDashboard } from "@/lib/desk/dashboard";
import { COPY } from "@/lib/desk/freshness";
import { hasHoldingsData } from "@/lib/desk/fundamentalView";
import { EVENTS_DAYS, incomeTile, needsYouFeed, openCallsTile, portfolioTiles, upcomingEarnings } from "@/lib/desk/fundamentalToday";
import { todayEt } from "@/lib/desk/futuresRead";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { DeskAiNotStarted } from "../shared/DeskAiNotStarted";
import { ImportLine } from "../shared/ImportLine";
import styles from "../fundamental.module.css";
import { NeedsYouFeed } from "./NeedsYouFeed";
import { TileList } from "./TileList";
import local from "./today.module.css";

/**
 * FD2 Today, Fundamental variant (02n §b3). Built from the real holdings, short-call and income reads plus the market strip:
 * `/dashboard/fundamental` is gated until its sources exist and is never requested. Dollars hide while values are masked.
 */
export function FundamentalToday() {
  const { maskValues, setMaskValues, selectedSymbol } = useDeskUi();
  const { status } = useDeskStatus();
  const { holdings, failed, loading, connection, refresh: refreshHoldings } = useHoldings();
  // ponytail: the as-of day is read once per visit; a screen left open past midnight keeps yesterday's day until it remounts.
  const [today] = useState(() => todayEt(new Date()));
  const hasData = holdings !== null && hasHoldingsData(holdings.import);

  const market = useDeskQuery("fund-today-market", (signal) => loadDashboard(undefined, { signal }), { intervalMs: 60_000 });
  const calls = useDeskQuery("fund-today-short-calls", (signal) => loadShortCalls({ signal }), { intervalMs: 60_000, enabled: hasData });
  const income = useDeskQuery("fund-today-income", (signal) => loadIncome(1, { signal }), { intervalMs: 300_000, enabled: hasData });

  const dim = connection === "reconnecting";
  const updating = market.updating || calls.updating || income.updating;
  const refresh = () => {
    refreshHoldings();
    market.refresh();
    calls.refresh();
    income.refresh();
  };

  const feed = needsYouFeed({ holdings, shortCalls: calls.data, today });
  const events = upcomingEarnings(holdings, today, EVENTS_DAYS);

  return (
    <div className={styles.screen} data-testid="fund-today">
      <header className={styles.head}>
        <h1 className={styles.pageTitle}>Today</h1>
        {market.data && <FreshnessBadge stamp={market.data.stamp} session={market.data.market.session} connection={market.connection === "reconnecting" ? "reconnecting" : "ok"} feed />}
        {updating && <span className={styles.caption}>{COPY.updating}</span>}
        <button type="button" className={styles.button} onClick={refresh}>Refresh</button>
      </header>

      {holdings && <ImportLine state={holdings.import} />}
      {maskValues && (
        <p className={`${styles.muted} ${local.hint}`} data-testid="fund-values-hidden">
          <span>{COPY.valuesHidden.replace(/ Show values$/, "")}</span>
          <button type="button" className={styles.button} onClick={() => setMaskValues(false)}>{COPY.maskShow}</button>
        </p>
      )}

      {holdings ? (
        <TileList tiles={portfolioTiles(holdings, maskValues)} label="Portfolio" testIdPrefix="fund-portfolio" dim={dim} />
      ) : failed ? (
        <ErrorBlock subject="holdings" onRetry={refreshHoldings} />
      ) : loading ? (
        <LoadingBlock label="Loading holdings…" height={72} />
      ) : null}

      {market.data ? (
        <MarketStrip strip={market.data.market_strip} nextUpdateAt={market.data.market.next_update_at ?? null} dim={market.connection === "reconnecting"} />
      ) : market.error ? (
        <ErrorBlock subject="market strip" onRetry={market.refresh} />
      ) : (
        <LoadingBlock label="Loading market…" height={64} />
      )}

      {holdings && (
        <div className={local.columns}>
          <div className={local.column}>
            <NeedsYouFeed items={feed} loading={hasData && calls.data === null && calls.error === null} dim={dim} />
            <DeskAiNotStarted />
          </div>
          <div className={local.column}>
            <TileList tiles={[incomeTile(income.data, today, maskValues), openCallsTile(calls.data)]} label="Covered calls" testIdPrefix="fund" dim={dim} />
            {calls.error !== null && calls.data === null && <ErrorBlock subject="open calls" onRetry={calls.refresh} />}
            {status?.options.state === "not_connected" && (calls.data?.length ?? 0) > 0 && <p className={styles.notice}>{COPY.optionQuotesNotConnected}</p>}
            <section className={styles.panel} aria-labelledby="fund-events-title">
              <h2 id="fund-events-title" className={styles.panelTitle}>Upcoming events</h2>
              {events.length === 0 ? (
                <p className={styles.muted}>No earnings dates for your holdings in the next two weeks</p>
              ) : (
                <ul className={styles.list} data-testid="fund-events">
                  {events.map((event) => (
                    <li key={`${event.symbol}-${event.date}`} className={local.event}>
                      <Link className={styles.link} href={`/stocks?symbol=${encodeURIComponent(event.symbol)}#overview`}>{event.symbol}</Link>
                      <span>{event.day}</span>
                      <span className={styles.muted}>Earnings · {event.when}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <p className={styles.notice} data-testid="fund-futures-deferred">
              {COPY.futuresDeferred} · <Link className={styles.link} href="/futures/read">Futures</Link>
            </p>
          </div>
        </div>
      )}
      <FundamentalRightRail symbol={selectedSymbol} />
    </div>
  );
}
