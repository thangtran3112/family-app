"use client";

import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { Badge } from "@/components/ui/Badge";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { formatEtDateClock } from "@/lib/desk/format";
import { overviewDateRows, overviewStats, sinceStartText, type OverviewDateRow } from "@/lib/replay/overviewView";
import { journalHref } from "@/lib/replay/practiceTabs";
import type { Thread, ThreadSummary } from "@/lib/replay/threads";
import type { ClockAccount } from "@/lib/replay/threadClock";
import { positionsCountText } from "@/lib/replay/positionTable";
import { formatBalance, formatDayResult, headlineFigure, startedWithText } from "@/lib/replay/threadView";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/** The page frame of the thread overview: the shared header (back link, name, status chip), the thread's tab strip when it has loaded, then the content. */
export function OverviewShell({ title, titleRef, aside, tabs, children }: { title: string; titleRef?: Ref<HTMLHeadingElement>; aside?: ReactNode; tabs?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.page}>
      <header className={`${hub.header} ${styles.headerSplit}`}>
        <div className={styles.titleBlock}>
          <Link href="/practice" className={styles.back}>{`← ${PRACTICE_COPY.threadPageBack}`}</Link>
          <h1 ref={titleRef} tabIndex={-1} className={hub.title}>{title}</h1>
        </div>
        {aside && <div className={hub.inline}>{aside}</div>}
      </header>
      {tabs}
      <div className={styles.pageBody}>{children}</div>
    </div>
  );
}

/** The status chip of the header. */
export function OverviewChips({ thread }: { thread: ThreadSummary["thread"] }) {
  return <Badge tone="neutral">{thread.status === "closed" ? PRACTICE_COPY.threadClosedBadge : PRACTICE_COPY.threadActive}</Badge>;
}

/**
 * Where the thread is: the balance with SIMULATED, what it started with, and the place line: the thread's time `T` and how many positions are
 * open at it. `account` is the thread's account at the server clock (ADR-0018): the big figure is then its equity and says "Equity" (the
 * ledger balance plus every open position at the clock's price, so it moves while the clock runs, whether or not she is on this page);
 * otherwise it is the ledger balance and says "Balance" (`headlineFigure`, D-156).
 */
export function PlaceStrip({ summary, account = null }: { summary: ThreadSummary; account?: ClockAccount | null }) {
  const { thread, clock } = summary;
  const live = account !== null && account.positions > 0;
  const headline = headlineFigure(thread.stats.balance, account);
  const positions = account === null ? summary.positions_open : account.positions;
  return (
    <section className={`${styles.panel} ${o.place}`} aria-label="Thread balance">
      <h2 className={styles.panelTitle}>{headline.label}</h2>
      <p className={hub.balanceRow}>
        <span className={hub.balanceValue} data-testid="thread-balance">{headline.value}</span>
        <SimulatedBadge />
      </p>
      {live && <p className={hub.muted} data-testid="thread-balance-open">{`${PRACTICE_COPY.clockAccountOpen} ${formatDayResult(account.open_pnl_usd)} at the clock · ${PRACTICE_COPY.clockAccountBalance} ${formatBalance(account.balance)}`}</p>}
      <p className={hub.muted}>{startedWithText(thread, account)}</p>
      {account !== null && <p className={hub.muted} data-testid="thread-since-start">{sinceStartText(account.since_start_usd)}</p>}
      <p className={o.placeLine}>
        {clock === null ? PRACTICE_COPY.landingNoClock : `${practiceText("overviewAtClock", { time: formatEtDateClock(clock.clock, { seconds: false }) })} · ${positionsCountText(positions)}`}
      </p>
    </section>
  );
}

/** Closed trades, win rate, wins, losses and open positions, and the journal link. A date is not a unit here: nothing counts days. */
export function StatsPanel({ thread, positionsOpen }: { thread: ThreadSummary["thread"]; positionsOpen: number }) {
  return (
    <section className={styles.panel} aria-label="Thread stats">
      <h2 className={styles.panelTitle}>{PRACTICE_COPY.overviewStatsTitle}</h2>
      <dl className={o.stats}>
        {overviewStats(thread.stats, positionsOpen).map((stat) => (
          <div key={stat.id} className={o.stat}>
            <dt className={hub.cap}>{stat.label}</dt>
            <dd>{stat.value}</dd>
          </div>
        ))}
      </dl>
      <Link href={journalHref(thread.id)} className={styles.textLink}>{PRACTICE_COPY.threadJournal}</Link>
    </section>
  );
}

const tone = (value: OverviewDateRow["resultTone"]) => o[value];

const DATE_COLUMNS: DenseColumn<OverviewDateRow>[] = [
  { key: "date", label: "Date", render: (row) => row.date },
  { key: "trades", label: "Trades", align: "right", render: (row) => row.trades },
  { key: "result", label: "Result", align: "right", render: (row) => <span className={tone(row.resultTone)}>{row.result}</span> },
  { key: "balance", label: "Balance", align: "right", render: (row) => row.balance },
];

/** One row per ET date with a realized trade, the newest first: the date, the trades closed that date, the result and the balance after it. The date is a label and a grouping key. */
export function DatesSection({ daily }: { daily: Thread["daily"] }) {
  return (
    <section className={`${styles.panel} ${o.tablePanel}`} aria-label={PRACTICE_COPY.overviewResultsTitle}>
      <div className={o.sectionHead}>
        <h2 className={styles.panelTitle}>{PRACTICE_COPY.overviewResultsTitle}</h2>
        <SimulatedBadge />
      </div>
      <DenseTable caption={PRACTICE_COPY.overviewResultsCaption} columns={DATE_COLUMNS} rows={overviewDateRows(daily)} rowKey={(row) => row.key} empty={PRACTICE_COPY.overviewResultsNone} />
    </section>
  );
}
