"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { PracticeTabs } from "@/components/practice/hub/PracticeTabs";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { Badge } from "@/components/ui/Badge";
import { PracticeNotice } from "@/components/practice/PracticeNotice";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadThread } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { dateLabel, hasNoTrades, openPositionsText, threadTiles } from "@/lib/replay/journalView";
import { threadPageHref } from "@/lib/replay/practiceTabs";
import { routeId } from "@/lib/replay/routeId";
import { journalStatusLine } from "@/lib/replay/statusLine";
import { formatBalance, formatDayResult, threadName } from "@/lib/replay/threadView";
import type { Thread } from "@/lib/replay/threads";
import { BalanceCurve } from "./BalanceCurve";
import { DateBars } from "./DateBars";
import { CloseThreadPanel, ThreadPlanPanel } from "./ThreadPlanPanel";
import { ThreadFills } from "./ThreadFills";
import { ThreadSidePanel } from "./ThreadSidePanel";
import { ThreadTiles } from "./ThreadTiles";
import styles from "./threadJournal.module.css";

/** `/practice/journal?thread=`: one practice thread's journal (02r). Read live, by ET date (ADR-0025). Every dollar on it is SIMULATED. Reads the URL, so the page wraps it in Suspense. */
export function ThreadJournalScreen() {
  const { id } = routeId(useSearchParams().get("thread"));
  const query = useDeskQuery(`replay-thread:${id}`, (signal) => loadThread(id ?? 0, { signal }), { enabled: id !== null });

  // JournalRoute opens this only with `?thread=` given, so a null id is a bad one (never "no thread chosen").
  if (id === null || (query.error instanceof DeskApiError && query.error.status === 404)) {
    return <div className={styles.center}><PracticeNotice title={PRACTICE_COPY.threadPageNotFound} /></div>;
  }
  if (query.data === null) {
    return (
      <div className={styles.center}>
        {query.error === null ? <LoadingBlock label={PRACTICE_COPY.journalThreadLoading} height={320} /> : <ErrorBlock message={PRACTICE_COPY.journalThreadLoadError} onRetry={query.refresh} />}
      </div>
    );
  }
  return <ThreadJournal key={query.data.thread.id} thread={query.data} onChanged={query.refresh} />;
}

/** "Started with $50,000 · +$123 so far", then the first date she traded on and how many dates have a closed trade. */
function subLine(thread: Thread): string {
  const { stats, startingBalance } = thread.thread;
  const start = `$${startingBalance.toLocaleString("en-US")}`;
  const change = stats.balance - startingBalance;
  const started = Math.round(change) === 0 ? practiceText("threadStartedFlat", { start }) : practiceText("threadStartedWith", { start, change: formatDayResult(change) });
  const first = thread.daily[0];
  const count = thread.daily.length;
  if (first === undefined) return started;
  return `${started} · ${practiceText("journalStartedDate", { date: dateLabel(first.day) })} · ${count === 1 ? PRACTICE_COPY.journalDatesTradedOne : practiceText("journalDatesTraded", { count })}`;
}

function ThreadJournal({ thread, onChanged }: { thread: Thread; onChanged: () => void }) {
  const { stats, status } = thread.thread;
  const empty = hasNoTrades(thread);
  const closed = status === "closed";
  const balance = formatBalance(stats.balance);
  const name = threadName(thread.thread);
  // At the 1180 band the right rail is a tab strip: each tab opens its own drawer, and the screen leaves room for them (D-038, D-040).
  const band = useShellBand();
  const [railOpen, setRailOpen] = useState<string[]>([]);
  useReportPracticeChrome({ day: null, playhead: null, scope: "days", status: journalStatusLine(thread.daily) });

  return (
    <div className={styles.screen} data-drawer={band === "1180" && railOpen.length > 0 ? "open" : undefined}>
      <PracticeTabs threadId={thread.thread.id} active="journal" />
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{name}</h1>
            <Badge tone="neutral">{closed ? PRACTICE_COPY.threadClosedBadge : PRACTICE_COPY.threadActive}</Badge>
          </div>
          <p className={styles.sub}>
            {`${subLine(thread)} `}
            <SimulatedBadge />
          </p>
        </div>
        <div className={styles.balance}>
          <span className={styles.balanceLabel}>{PRACTICE_COPY.balanceNow}</span>
          <span className={styles.balanceValue}>{balance}</span>
          <SimulatedBadge />
        </div>
      </header>
      <ThreadSidePanel thread={thread} />
      <div className={styles.body}>
        <div className={styles.center}>
          {closed && (
            <p className={`${styles.banner} ${styles.bannerRow}`} role="status">
              <span>{practiceText("journalClosedBanner", { balance })}</span>
              <Link href="/practice#threads" className={styles.link}>{PRACTICE_COPY.threadStartNew}</Link>
            </p>
          )}
          {/* The balance is the ledger's: a position still open is not in it. It is in the Portfolio, priced at the clock. */}
          {thread.positions_open > 0 && (
            <p className={styles.hint} data-testid="journal-open-positions">
              {thread.positions_open === 1 ? PRACTICE_COPY.journalOpenPositionsOne : practiceText("journalOpenPositions", { positions: openPositionsText(thread.positions_open) })}
              {" · "}
              <Link href={threadPageHref(thread.thread.id, "portfolio")} className={styles.link}>{PRACTICE_COPY.journalOpenPortfolio}</Link>
            </p>
          )}
          {empty ? (
            <div className={styles.emptyNote}>
              <p className={styles.emptyLine}><strong>{practiceText("journalEmptyLine", { balance })}</strong></p>
              <p className={styles.muted}>{PRACTICE_COPY.journalEmpty}</p>
            </div>
          ) : (
            <>
              <section className={styles.section} aria-labelledby="thread-curve-title">
                <div className={styles.sectionHead}>
                  <h2 id="thread-curve-title" className={styles.sectionTitle}>{PRACTICE_COPY.journalCurveTitle}</h2>
                  <SimulatedBadge />
                </div>
                <p className={styles.hint}>{PRACTICE_COPY.journalCurveHint}</p>
                <BalanceCurve thread={thread} />
              </section>
              <section className={styles.section} aria-labelledby="thread-bars-title">
                <div className={styles.sectionHead}>
                  <h2 id="thread-bars-title" className={styles.sectionTitle}>{PRACTICE_COPY.journalBarsTitle}</h2>
                  <SimulatedBadge />
                </div>
                <p className={styles.hint}>{PRACTICE_COPY.journalBarsHint}</p>
                <DateBars thread={thread} />
              </section>
              <section className={styles.section} aria-labelledby="thread-summary-title">
                <div className={styles.sectionHead}>
                  <h2 id="thread-summary-title" className={styles.sectionTitle}>{PRACTICE_COPY.summaryTitle}</h2>
                  <SimulatedBadge />
                </div>
                <p className={styles.hint}>{PRACTICE_COPY.journalSummaryHint}</p>
                <ThreadTiles tiles={threadTiles(thread)} />
              </section>
            </>
          )}
          <ThreadFills thread={thread} />
        </div>
      </div>
      <RightRail
        label="Thread details"
        multi
        openIds={railOpen}
        onOpenIdsChange={setRailOpen}
        sections={[
          { id: "plan", label: PRACTICE_COPY.threadPlanTitle, node: <ThreadPlanPanel thread={thread} onChanged={onChanged} /> },
          { id: "close", label: PRACTICE_COPY.threadClose, node: <CloseThreadPanel thread={thread} onChanged={onChanged} /> },
        ]}
      />
    </div>
  );
}
