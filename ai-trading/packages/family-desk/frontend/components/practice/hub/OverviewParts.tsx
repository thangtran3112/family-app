"use client";

import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { Badge } from "@/components/ui/Badge";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { adherenceStat, overviewDayRows, threadProgress, type EquityDays, type OverviewDayRow } from "@/lib/replay/overviewView";
import type { Thread, ThreadSummary } from "@/lib/replay/threads";
import type { ClockAccount } from "@/lib/replay/threadClock";
import { formatBalance, formatDayResult, headlineFigure, startedWithText, threadModeLabel, winRateText } from "@/lib/replay/threadView";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/** The page frame of the thread overview: the shared header (back link, name, mode and status chips), the thread's tab strip when it has loaded, then the content. */
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

/** The mode and status chips of the header. */
export function OverviewChips({ thread }: { thread: ThreadSummary["thread"] }) {
  const closed = thread.status === "closed";
  return (
    <>
      <Badge tone="neutral">{threadModeLabel(thread.mode)}</Badge>
      <Badge tone="neutral">{closed ? PRACTICE_COPY.threadClosedBadge : PRACTICE_COPY.threadActive}</Badge>
    </>
  );
}

/**
 * Where the thread is: the balance with SIMULATED, what it started with, the place line and the days so far. `children` adds the swing
 * facts. `account` is a day thread's account at the server clock (ADR-0018): the big figure is then its equity and says "Equity" (the ledger
 * balance plus every open position at the clock's price, so it moves while the clock runs, whether or not she is on this page); otherwise it
 * is the ledger balance and says "Balance" (`headlineFigure`, D-156).
 */
export function PlaceStrip({ summary, planFinished = false, account = null, children }: { summary: ThreadSummary; planFinished?: boolean; account?: ClockAccount | null; children?: ReactNode }) {
  const { thread } = summary;
  const progress = threadProgress(summary, planFinished);
  const live = account !== null && account.positions > 0;
  const headline = headlineFigure(thread.stats.balance, account);
  return (
    <section className={`${styles.panel} ${o.place}`} aria-label="Thread balance">
      <h2 className={styles.panelTitle}>{headline.label}</h2>
      <p className={hub.balanceRow}>
        <span className={hub.balanceValue} data-testid="thread-balance">{headline.value}</span>
        <SimulatedBadge />
      </p>
      {live && <p className={hub.muted} data-testid="thread-balance-open">{`${PRACTICE_COPY.clockAccountOpen} ${formatDayResult(account.open_pnl_usd)} at the clock · ${PRACTICE_COPY.clockAccountBalance} ${formatBalance(account.balance)}`}</p>}
      {account !== null && (
        <p className={hub.muted} data-testid="thread-buying-power">{practiceText("buyingPowerLine", { label: PRACTICE_COPY.clockAccountBuyingPower, amount: formatBalance(account.buying_power_usd) })}</p>
      )}
      <p className={hub.muted}>{startedWithText(thread, summary.swing)}</p>
      {children}
      <p className={o.placeLine}>{progress.sub === PRACTICE_COPY.landingProgressNoDays ? progress.main : `${progress.main} · ${progress.sub}`}</p>
    </section>
  );
}

/** Days practiced, skipped, win rate and adherence (with which day it is and what it means), and the journal link. */
export function StatsPanel({ thread }: { thread: ThreadSummary["thread"] & { id: number } }) {
  const { stats } = thread;
  const adherence = adherenceStat(stats);
  return (
    <section className={styles.panel} aria-label="Thread stats">
      <h2 className={styles.panelTitle}>{PRACTICE_COPY.overviewStats}</h2>
      <dl className={o.stats}>
        <div className={o.stat}>
          <dt className={hub.cap}>{PRACTICE_COPY.threadDaysPracticed}</dt>
          <dd>{stats.daysPracticed}</dd>
        </div>
        <div className={o.stat}>
          <dt className={hub.cap}>{PRACTICE_COPY.threadSkipped}</dt>
          <dd>{stats.daysSkipped}</dd>
        </div>
        <div className={o.stat}>
          <dt className={hub.cap}>{PRACTICE_COPY.threadWinRate}</dt>
          <dd>{winRateText(stats.winRate)}</dd>
        </div>
        <div className={o.stat}>
          <dt className={hub.cap}>{PRACTICE_COPY.threadAdherence}</dt>
          <dd>
            {adherence.value}
            <span className={o.statHint}>{` ${adherence.hint}`}</span>
          </dd>
        </div>
      </dl>
      <p className={hub.hint}>{PRACTICE_COPY.threadAdherenceMeaning}</p>
      <Link href={`/practice/journal?thread=${thread.id}`} className={styles.textLink}>{PRACTICE_COPY.threadJournal}</Link>
    </section>
  );
}

const tone = (value: OverviewDayRow["resultTone"]) => o[value];

const DAY_COLUMNS: DenseColumn<OverviewDayRow>[] = [
  { key: "day", label: "Day", render: (row) => <Link href={row.href} className={o.rowLink}>{row.title}</Link> },
  { key: "status", label: "Status", render: (row) => row.status },
  { key: "trades", label: "Trades", align: "right", render: (row) => row.trades },
  { key: "result", label: "Result", align: "right", render: (row) => <span className={tone(row.resultTone)}>{row.result}</span> },
  { key: "adherence", label: "Adherence", align: "right", render: (row) => row.adherence },
  { key: "balance", label: "Balance", align: "right", render: (row) => row.balance },
];

/** One row per ended day, the newest first: day number and weekday (never a date), practiced or skipped, trades, result, adherence and the balance. Each day opens its board. */
export function DaysSection({ daily, equity }: { daily: Thread["daily"]; equity?: EquityDays }) {
  return (
    <section className={`${styles.panel} ${o.tablePanel}`} aria-label={PRACTICE_COPY.overviewDaysTitle}>
      <div className={o.sectionHead}>
        <h2 className={styles.panelTitle}>{PRACTICE_COPY.overviewDaysTitle}</h2>
        <SimulatedBadge />
      </div>
      <DenseTable caption={PRACTICE_COPY.overviewDaysCaption} columns={DAY_COLUMNS} rows={overviewDayRows(daily, equity)} rowKey={(row) => row.key} empty={PRACTICE_COPY.overviewDaysNone} />
    </section>
  );
}
