"use client";

import Link from "next/link";
import { useState } from "react";
import { SwingContinue } from "@/components/practice/hub/SwingContinue";
import { HoldsTable } from "@/components/practice/swing/HoldsTable";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { formatEtDay } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { HUB_SWING_COPY } from "@/lib/replay/hubSwing";
import { swingDatesHidden, swingCardView } from "@/lib/replay/swing";
import { swingGate } from "@/lib/replay/overviewView";
import { loadHolds, loadWeeks } from "@/lib/replay/swingApi";
import { journalStatusLine } from "@/lib/replay/statusLine";
import type { Thread } from "@/lib/replay/threads";
import { formatBalance, startedWithText, threadModeLabel, threadName } from "@/lib/replay/threadView";
import { mixOf, universeSummary } from "@/lib/replay/universeView";
import { SwingEquityCurve } from "./SwingEquityCurve";
import { SwingWeeksTable } from "./SwingWeeksTable";
import { CloseThreadPanel, ThreadPlanPanel } from "./ThreadPlanPanel";
import { ThreadSidePanel } from "./ThreadSidePanel";
import styles from "./threadJournal.module.css";
import { FactList } from "@/components/ui/FactList";

/**
 * `/practice/journal?thread=` for a swing thread (02p h): the balance and the equity at each close, the weeks with links to
 * their reviews, the open practice holds, and what comes next (Continue, the finished week's review, or nothing). The day
 * thread's journal is a different screen. Every dollar on it is SIMULATED, and no date shows while the thread hides dates.
 */
export function SwingThreadJournal({ thread, onChanged }: { thread: Thread; onChanged: () => void }) {
  const { id, stats, status, startingBalance, swing: setup } = thread.thread;
  const state = thread.swing;
  const closed = status === "closed";
  // The answers follow the thread's state, so a closed thread or a newly finished day reads again.
  const stamp = `${id}:${status}:${state?.days_ended ?? 0}`;
  const weeks = useDeskQuery(`swing-weeks:${stamp}`, (signal) => loadWeeks(id, { signal }));
  const holds = useDeskQuery(`swing-holds:${stamp}`, (signal) => loadHolds(id, "open", { signal }));
  // At the 1180 band the right rail is a tab strip: each tab opens its own drawer, and the screen leaves room for them (D-038, D-040).
  const band = useShellBand();
  const [railOpen, setRailOpen] = useState<string[]>([]);
  useReportPracticeChrome({ day: null, hidden: false, playhead: null, scope: "days", status: journalStatusLine(thread.daily) });
  if (!state) return null; // the screen only opens this for a thread that carries its swing state

  const balance = formatBalance(stats.balance);
  const name = threadName(thread.thread).replace(" thread", "");
  const hidden = swingDatesHidden(setup);
  const view = swingCardView(thread);
  const where = state.next === "finished" ? practiceText("swingFinished", { days: state.days }) : practiceText("planDay", { day: state.day_no, of: state.days });
  const nextText =
    view?.action.kind === "none"
      ? PRACTICE_COPY.swingThreadFinished
      : (swingGate(thread)?.locked ?? view?.notice ?? `${where} · ${practiceText("swingCardWeek", { week: state.week_no, weeks: state.weeks })}`);

  return (
    <div className={styles.screen} data-drawer={band === "1180" && railOpen.length > 0 ? "open" : undefined}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{`Thread · ${name} · ${practiceText("swingCardWeek", { week: state.week_no, weeks: state.weeks })}`}</h1>
            <Badge tone="neutral">{threadModeLabel(thread.thread.mode)}</Badge>
          </div>
          <p className={styles.sub}>{`${startedWithText(thread.thread, state)} · ${where}${hidden ? ` · ${HUB_SWING_COPY.dateHidden}` : ""}`}</p>
        </div>
        <div className={styles.balanceStack}>
          <div className={styles.balance}>
            <span className={styles.balanceLabel}>{PRACTICE_COPY.balanceNow}</span>
            <span className={styles.balanceValue}>{balance}</span>
            <SimulatedBadge />
          </div>
          <div className={styles.balance}>
            <span className={styles.balanceLabel}>{HUB_SWING_COPY.curveEquity}</span>
            <span className={styles.equityValue}>{formatBalance(state.equity_usd)}</span>
            <SimulatedBadge />
          </div>
        </div>
      </header>
      <ThreadSidePanel thread={thread} weeks={[]} swing />
      <div className={styles.body}>
        <div className={styles.center}>
          {closed && (
            <p className={styles.banner} role="status">
              {practiceText("journalThreadClosed", { balance })} <Link href="/practice#threads" className={styles.link}>{PRACTICE_COPY.threadStartNew}</Link>
            </p>
          )}
          {!closed && view && (
            <div className={styles.nextRow}>
              <p className={`${styles.muted} ${styles.nextText}`}>{nextText}</p>
              {view.action.kind === "review" && view.action.weekNo !== null && view.action.label !== null && (
                <Button client href={`/practice/week?thread=${id}&week=${view.action.weekNo}`} variant="primary">{view.action.label}</Button>
              )}
              {(view.action.kind === "start" || view.action.kind === "continue") && view.action.label !== null && (
                <SwingContinue threadId={id} label={view.action.label} onChanged={onChanged} />
              )}
            </div>
          )}

          <section className={styles.section} aria-labelledby="swing-curve-title">
            <div className={styles.sectionHead}>
              <h2 id="swing-curve-title" className={styles.sectionTitle}>{PRACTICE_COPY.swingEquityTitle}</h2>
              <SimulatedBadge />
            </div>
            <p className={styles.hint}>{HUB_SWING_COPY.curveLine}</p>
            {state.equity_series.length === 0 ? (
              <p className={styles.muted}>{HUB_SWING_COPY.noDaysYet}</p>
            ) : (
              <SwingEquityCurve state={state} startingBalance={startingBalance} />
            )}
          </section>

          <section className={styles.section} aria-labelledby="swing-weeks-title">
            <div className={styles.sectionHead}>
              <h2 id="swing-weeks-title" className={styles.sectionTitle}>{HUB_SWING_COPY.weeksTitle}</h2>
              <SimulatedBadge />
            </div>
            <p className={styles.hint}>{HUB_SWING_COPY.weeksHint}</p>
            {weeks.loading ? (
              <LoadingBlock label="Loading the weeks…" height={96} />
            ) : weeks.data === null ? (
              <ErrorBlock message={HUB_SWING_COPY.weeksLoadError} onRetry={weeks.refresh} />
            ) : (
              <SwingWeeksTable threadId={id} weeks={weeks.data.weeks} daysEnded={state.days_ended} />
            )}
          </section>

          <section className={styles.section} aria-labelledby="swing-holds-title">
            <div className={styles.sectionHead}>
              <h2 id="swing-holds-title" className={styles.sectionTitle}>{HUB_SWING_COPY.holdsTitle}</h2>
              <SimulatedBadge />
            </div>
            <p className={styles.hint}>{HUB_SWING_COPY.holdsHint}</p>
            {holds.loading ? (
              <LoadingBlock label="Loading the holds…" height={96} />
            ) : holds.data === null ? (
              <ErrorBlock message={HUB_SWING_COPY.holdsLoadError} onRetry={holds.refresh} />
            ) : (
              <HoldsTable holds={holds.data.holds} caption="Open practice holds" tape={setup?.tape ?? "off"} simulatedLabel={false} />
            )}
          </section>
        </div>
      </div>
      <RightRail
        label="Thread details"
        multi
        openIds={railOpen}
        onOpenIdsChange={setRailOpen}
        sections={[
          { id: "swing", label: PRACTICE_COPY.swingModeLabel, node: <SwingSetupPanel thread={thread} hidden={hidden} /> },
          { id: "plan", label: PRACTICE_COPY.threadPlanTitle, node: <ThreadPlanPanel thread={thread} onChanged={onChanged} /> },
          { id: "close", label: PRACTICE_COPY.threadClose, node: <CloseThreadPanel thread={thread} onChanged={onChanged} /> },
        ]}
      />
    </div>
  );
}

/** What the thread was started with (02p c1): the calendar, the interval and tape, the cap on open holds, and the frozen universe's mix. */
function SwingSetupPanel({ thread, hidden }: { thread: Thread; hidden: boolean }) {
  const setup = thread.thread.swing;
  if (!setup) return null;
  const rows: Array<{ label: string; value: string; money?: boolean }> = [
    { label: "Sessions", value: String(setup.sessions) },
    { label: "Dates", value: hidden ? "Hidden" : `From ${formatEtDay(setup.firstDay)}` },
    { label: "Interval", value: setup.interval },
    { label: "Tape", value: setup.tape === "on" ? PRACTICE_COPY.swingTapeYes : PRACTICE_COPY.swingTapeNo },
    { label: "Open holds at most", value: String(setup.maxOpenHolds) },
    { label: "Risk per hold", value: setup.riskPerHoldUsd === undefined ? "None" : formatBalance(setup.riskPerHoldUsd), money: setup.riskPerHoldUsd !== undefined },
  ];
  return (
    <div className={styles.stack}>
      <FactList
        divided
        facts={rows.map((row) => ({
          id: row.label,
          label: row.label,
          value: (
            <>
              {row.value}
              {row.money && <SimulatedBadge />}
            </>
          ),
        }))}
      />
      <p className={styles.planNote}>{universeSummary({ size: setup.universe.length, mix: mixOf(setup.universe) })}</p>
    </div>
  );
}
