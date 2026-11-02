"use client";

import Link from "next/link";
import { PortfolioPanel, useDayPortfolio } from "@/components/practice/replay/Portfolio";
import { PositionTable } from "@/components/practice/replay/PositionTable";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { Badge } from "@/components/ui/Badge";
import { EmptyBlock, QueryBoundary } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import type { ClockAccount } from "@/lib/replay/threadClock";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { HUB_SWING_COPY } from "@/lib/replay/hubSwing";
import { swingPositionRow } from "@/lib/replay/positionTable";
import { freeCashText } from "@/lib/replay/swing";
import { loadHolds } from "@/lib/replay/swingApi";
import type { Thread } from "@/lib/replay/threads";
import { formatBalance } from "@/lib/replay/threadView";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/**
 * The Portfolio tab of the thread page. A day thread: the names of the day that is open (each with its trade and the day's P/L,
 * Exit on a held one), the same panel the day list and the replay carry. A swing thread: its equity and free cash, and the holds
 * carried between days. Both are `PositionTable`, the broker-style list (last, change, position, average price, value, P/L). With no day open a day thread has nothing to show and says where to start one. All SIMULATED.
 */
export function PortfolioTab({ summary, clockRevision = 0, account = null }: { summary: Thread; clockRevision?: number; account?: ClockAccount | null }) {
  const { thread, today, swing: state } = summary;
  if (thread.mode === "swing" && state) return <SwingPortfolio summary={summary} />;
  if (today === null) return <EmptyBlock title={PRACTICE_COPY.portfolioNoDay} />;
  return <DayPortfolio dayListId={today.day_list_id} clockRevision={clockRevision} account={account} />;
}

/** The names of the open day, priced at the thread clock: it is read again whenever the clock moves (ADR-0018). */
function DayPortfolio({ dayListId, clockRevision, account }: { dayListId: number; clockRevision: number; account: ClockAccount | null }) {
  const query = useDayPortfolio(dayListId, clockRevision);
  return (
    <section className={`${styles.panel} ${o.tablePanel}`} aria-label={PRACTICE_COPY.dayPortfolio}>
      <h2 className={styles.panelTitle}>{PRACTICE_COPY.dayPortfolio}</h2>
      {account !== null && (
        <p className={hub.muted} data-testid="portfolio-account">
          {`${practiceText("swingEquity", { amount: formatBalance(account.equity_usd) })} · ${practiceText("buyingPowerLine", { label: PRACTICE_COPY.clockAccountBuyingPower, amount: formatBalance(account.buying_power_usd) })}`}
        </p>
      )}
      <QueryBoundary query={query} loading="Loading the portfolio…" height={96} message={PRACTICE_COPY.dayLoadError}>
        {() => <PortfolioPanel dayListId={dayListId} query={query} />}
      </QueryBoundary>
    </section>
  );
}

function SwingPortfolio({ summary }: { summary: Thread }) {
  const { thread, swing: state } = summary;
  // The answers follow the thread's state, so a newly ended day reads again (the journal keys them the same way).
  const stamp = `${thread.id}:${thread.status}:${state?.days_ended ?? 0}`;
  const holds = useDeskQuery(`swing-holds:${stamp}`, (signal) => loadHolds(thread.id, "open", { signal }));
  if (!state) return null;

  return (
    <section className={`${styles.panel} ${o.tablePanel}`} aria-label={HUB_SWING_COPY.holdsTitle}>
      <div className={o.sectionHead}>
        <h2 className={styles.panelTitle}>{HUB_SWING_COPY.holdsTitle}</h2>
        <span className={o.headBadges}>
          <Badge tone="neutral">{practiceText("overviewHoldsCount", { n: state.holds_open })}</Badge>
          <SimulatedBadge />
        </span>
      </div>
      <p className={hub.muted}>{`${practiceText("swingEquity", { amount: formatBalance(state.equity_usd) })} · ${freeCashText(state.free_cash_usd)}`}</p>
      <p className={hub.hint}>{HUB_SWING_COPY.holdsHint}</p>
      <QueryBoundary query={holds} loading="Loading the holds…" height={96} message={HUB_SWING_COPY.holdsLoadError}>
        {(data) => (
          <PositionTable caption={PRACTICE_COPY.overviewHoldsCaption} rows={data.holds.map(swingPositionRow)} empty={PRACTICE_COPY.swingNoHoldsOpen} />
        )}
      </QueryBoundary>
      <Link href={`/practice/journal?thread=${thread.id}`} className={styles.textLink}>{PRACTICE_COPY.overviewHoldsLink}</Link>
    </section>
  );
}
