"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { adherenceStat, overviewDayRows, threadProgress, type OverviewDayRow } from "@/lib/replay/overviewView";
import type { Thread, ThreadSummary } from "@/lib/replay/threads";
import { formatBalance, startedWithText, threadModeLabel, winRateText } from "@/lib/replay/threadView";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/** The page frame of the thread overview: the shared header (back link, name, mode and status chips) over the content. */
export function OverviewShell({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.page}>
      <header className={`${hub.header} ${styles.headerSplit}`}>
        <div className={styles.titleBlock}>
          <Link href="/practice" className={styles.back}>{`← ${PRACTICE_COPY.threadPageBack}`}</Link>
          <h1 className={hub.title}>{title}</h1>
        </div>
        {aside && <div className={hub.inline}>{aside}</div>}
      </header>
      <div className={styles.pageBody}>{children}</div>
    </div>
  );
}

/** The mode and status chips of the header. */
export function OverviewChips({ thread }: { thread: ThreadSummary["thread"] }) {
  const closed = thread.status === "closed";
  return (
    <>
      <span className={hub.chip}>{threadModeLabel(thread.mode)}</span>
      <span className={hub.chip}>{closed ? PRACTICE_COPY.threadClosedBadge : PRACTICE_COPY.threadActive}</span>
    </>
  );
}

/** Where the thread is: the balance with SIMULATED, what it started with, the place line and the days so far. `children` adds the swing facts. */
export function PlaceStrip({ summary, children }: { summary: ThreadSummary; children?: ReactNode }) {
  const { thread } = summary;
  const progress = threadProgress(summary);
  return (
    <section className={`${styles.panel} ${o.place}`} aria-label="Thread balance">
      <span className={hub.cap}>{PRACTICE_COPY.threadBalance}</span>
      <p className={hub.balanceRow}>
        <span className={hub.balanceValue}>{formatBalance(thread.stats.balance)}</span>
        <SimulatedBadge />
      </p>
      <p className={hub.muted}>{startedWithText(thread)}</p>
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
      <Link href={`/practice/journal?thread=${thread.id}`} className={styles.mutedLink}>{PRACTICE_COPY.threadJournal}</Link>
    </section>
  );
}

const tone = (value: OverviewDayRow["resultTone"]) => o[value];

const DAY_COLUMNS: DenseColumn<OverviewDayRow>[] = [
  { key: "day", label: "Day", render: (row) => <Link href={row.href} className={o.link}>{row.title}</Link> },
  { key: "status", label: "Status", render: (row) => row.status },
  { key: "trades", label: "Trades", align: "right", render: (row) => row.trades },
  { key: "result", label: "Result", align: "right", render: (row) => <span className={tone(row.resultTone)}>{row.result}</span> },
  { key: "adherence", label: "Adherence", align: "right", render: (row) => row.adherence },
  { key: "balance", label: "Balance", align: "right", render: (row) => row.balance },
];

/** One row per ended day, the newest first: day number and weekday (never a date), practiced or skipped, trades, result, adherence and the balance. Each day opens its board. */
export function DaysSection({ daily }: { daily: Thread["daily"] }) {
  return (
    <section className={`${styles.panel} ${o.tablePanel}`} aria-label={PRACTICE_COPY.overviewDaysTitle}>
      <div className={o.sectionHead}>
        <h2 className={styles.panelTitle}>{PRACTICE_COPY.overviewDaysTitle}</h2>
        <SimulatedBadge />
      </div>
      <DenseTable caption={PRACTICE_COPY.overviewDaysCaption} columns={DAY_COLUMNS} rows={overviewDayRows(daily)} rowKey={(row) => row.key} empty={PRACTICE_COPY.overviewDaysNone} />
    </section>
  );
}
