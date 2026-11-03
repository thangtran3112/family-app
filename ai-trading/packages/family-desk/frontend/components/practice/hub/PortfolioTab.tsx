"use client";

import { PortfolioPanel, useThreadPortfolio } from "@/components/practice/replay/Portfolio";
import { EmptyBlock, QueryBoundary } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import type { ClockAccount } from "@/lib/replay/threadClock";
import type { Thread } from "@/lib/replay/threads";
import { formatBalance } from "@/lib/replay/threadView";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/**
 * The Portfolio tab of the thread page (ADR-0025): every open position across the thread's lanes, priced at the thread clock `T` and read again
 * whenever the clock moves, with the account beside it, and below the table the working orders. A position persists through the close,
 * the night and a Jump, so a holding shows its gain or loss at the time the clock has reached. A closed thread's positions stay, priced at the time
 * it stopped, and read only. With no setup a thread has no clock and nothing to show. All SIMULATED.
 */
export function PortfolioTab({ summary, clockRevision = 0, account = null }: { summary: Thread; clockRevision?: number; account?: ClockAccount | null }) {
  const { thread, clock } = summary;
  const query = useThreadPortfolio(thread.id, clockRevision, clock !== null);
  if (clock === null) return <EmptyBlock title={PRACTICE_COPY.portfolioNotStarted} />;
  return (
    <section className={`${styles.panel} ${o.tablePanel}`} aria-label={PRACTICE_COPY.portfolioTitle}>
      <h2 className={styles.panelTitle}>{PRACTICE_COPY.portfolioTitle}</h2>
      {account !== null && (
        <p className={hub.muted} data-testid="portfolio-account">
          {`${practiceText("portfolioEquity", { amount: formatBalance(account.equity_usd) })} · ${practiceText("buyingPowerLine", { label: PRACTICE_COPY.clockAccountBuyingPower, amount: formatBalance(account.buying_power_usd) })}`}
        </p>
      )}
      <QueryBoundary query={query} loading={PRACTICE_COPY.portfolioLoading} height={96} message={PRACTICE_COPY.portfolioLoadError}>
        {() => <PortfolioPanel threadId={thread.id} query={query} readOnly={thread.status === "closed"} />}
      </QueryBoundary>
    </section>
  );
}
