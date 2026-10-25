"use client";

import { alertsBanner, COPY, statusBarText } from "@/lib/desk/freshness";
import { formatEtTimeZone } from "@/lib/desk/format";
import { useDeskStatus } from "./DeskContext";
import { useReplayBadge } from "./PracticeChrome";
import styles from "./statusbar.module.css";

/** 24 px bar: quote source and state, last update in ET, alert delivery state (02l §b2). */
export function StatusBar() {
  const { status, failed, connection } = useDeskStatus();
  const quotes = status?.quotes ?? null;
  const quoteText = failed ? COPY.statusUnavailable : statusBarText({ stamp: quotes, session: status?.market.session, connection, feed: true });
  const replaying = useReplayBadge() !== null;
  const alertsText = status ? (alertsBanner(status.alerts.state) ?? COPY.alertsRunning) : null;

  return (
    <footer className={styles.bar} aria-label="Status">
      {replaying ? (
        <span>Replay · past market data · no live quotes on this screen</span>
      ) : (
        <>
          <span>{quoteText}</span>
          {quotes?.as_of && <span>Last update {formatEtTimeZone(quotes.as_of)}</span>}
        </>
      )}
      {alertsText && <span className={styles.alerts} data-paused={status?.alerts.state !== "running"}>{alertsText}</span>}
    </footer>
  );
}
