"use client";

import { usePathname } from "next/navigation";
import { reportUrl } from "@/lib/desk/feedbackContext";
import { alertsBanner, COPY, statusBarText } from "@/lib/desk/freshness";
import { formatEtTimeZone } from "@/lib/desk/format";
import { useDeskStatus } from "./DeskContext";
import { usePracticeChrome, useReplayBadge } from "./PracticeChrome";
import styles from "./statusbar.module.css";

/** The quiet link at the right end of the bar (02s): opens the filing form with the screen she is on, query included. */
function ReportProblem({ pathname }: { pathname: string }) {
  return (
    <a
      className={styles.report}
      href={reportUrl(pathname)}
      // The route in the link is the path alone; read the address bar at click time so the practice day or symbol in the query travels too.
      onClick={(event) => {
        event.currentTarget.href = reportUrl(`${window.location.pathname}${window.location.search}`);
      }}
    >
      Report a problem
    </a>
  );
}

/** 24 px bar: quote source and state, last update in ET, alert delivery state (02l §b2). A Practice route may bring its own line (D-043). */
export function StatusBar() {
  const { status, failed, connection } = useDeskStatus();
  const pathname = usePathname() ?? "/";
  const quotes = status?.quotes ?? null;
  const quoteText = failed ? COPY.statusUnavailable : statusBarText({ stamp: quotes, session: status?.market.session, connection, feed: true });
  const replaying = useReplayBadge() !== null;
  const own = usePracticeChrome()?.status ?? null;
  const alertsText = status ? (alertsBanner(status.alerts.state) ?? COPY.alertsRunning) : null;
  const onFeedback = pathname === "/feedback" || pathname.startsWith("/feedback/");

  if (own) {
    return (
      <footer className={styles.bar} aria-label="Status">
        {own.left.map((item) => <span key={item} className={styles.item}>{item}</span>)}
        <span className={styles.right}>
          {own.right.map((item) => <span key={item} className={styles.item}>{item}</span>)}
          <ReportProblem pathname={pathname} />
        </span>
      </footer>
    );
  }

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
      {onFeedback && <span>Feedback stays on this Desk · nothing is sent to a third-party tracker</span>}
      <span className={styles.right}>
        {alertsText && <span className={styles.alerts} data-paused={status?.alerts.state !== "running"}>{alertsText}</span>}
        <ReportProblem pathname={pathname} />
      </span>
    </footer>
  );
}
