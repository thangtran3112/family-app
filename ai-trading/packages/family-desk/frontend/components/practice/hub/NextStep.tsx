"use client";

import Link from "next/link";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { Button } from "@/components/ui/Button";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadDayList } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { openTodayText, planCard } from "@/lib/replay/dayView";
import type { PracticePlan } from "@/lib/replay/daily";
import { planFinishedLine, swingGate } from "@/lib/replay/overviewView";
import { swingCardView } from "@/lib/replay/swing";
import type { ThreadSummary } from "@/lib/replay/threads";
import { todayView } from "@/lib/replay/threadView";
import { ThreadAction, planOpensIn } from "./ThreadAction";
import { ResultLine } from "./ThreadTable";
import hub from "./hub.module.css";
import styles from "./landing.module.css";

/**
 * The overview's one primary step (a region named "Practice day"). A day thread: Resume, Start day or New plan needed, with
 * Replace plan beside it. A swing thread: Continue or Start Day n, or while its week review is owed (the gate) the review first
 * and, beneath it, what unlocks after it. A closed thread has none. The last day's result sits under the button.
 */
export function NextStep({ summary, plan, onChanged, onNewPlan }: { summary: ThreadSummary; plan: PracticePlan | null; onChanged: () => void; onNewPlan: () => void }) {
  const { thread, today, last_day: lastDay } = summary;
  const closed = thread.status === "closed";
  const swing = swingCardView(summary);
  const gate = swingGate(summary);
  const view = todayView(today, lastDay);
  const canReplace = !closed && thread.mode === "day" && planOpensIn(plan, thread);
  // The plan's data is still being prepared (D-084): the action slot says so, and the card says nothing else about Day 1.
  const preparing = canReplace && planCard(plan).action === "none";
  const preparingHint = preparing ? planCard(plan).detail : null;
  // A thread with a plan and no day yet: nothing to resume, so it says what comes next instead of "no day open".
  const fresh = !closed && thread.mode === "day" && today === null && lastDay === null && planOpensIn(plan, thread) && !preparing;
  const finished = swing?.action.kind === "none";
  // A day plan whose last day has ended: its summary sits above the one action, "Start a new plan" (D-096).
  const planDone = !closed && thread.mode === "day" && plan !== null && plan.thread_id === thread.id && plan.finished;
  const title = closed ? PRACTICE_COPY.threadClosedTitle : swing ? PRACTICE_COPY.overviewNext : view.label;
  // A day under way may hold open trades: the server prices them at the day clock (the day list's `day_pnl`).
  const live = useDeskQuery(`thread-open:${today?.day_list_id}`, (signal) => loadDayList(today?.day_list_id ?? 0, {}, { signal }), {
    enabled: !closed && today?.status === "practicing",
  });
  const openText = live.data === null ? null : openTodayText(live.data.day_pnl);
  const result = (
    <>
      <ResultLine pnl={view.pnl} line={view.line} />
      {live.data !== null && openText !== null && (
        <>
          {" · "}
          <span data-testid="today-open"><ResultLine pnl={live.data.day_pnl.open_usd} line={openText} /></span>
          {" "}
          <SimulatedBadge />
        </>
      )}
    </>
  );

  return (
    <section className={`${styles.panel} ${styles.nextStep}`} aria-label="Practice day">
      <h2 className={styles.panelTitle}>{title}</h2>
      {closed ? (
        <>
          <p className={hub.muted}>{PRACTICE_COPY.threadPageClosed}</p>
          <div className={styles.dayActions}>
            <Button client href={`/practice/journal?thread=${thread.id}`} variant="primary">{PRACTICE_COPY.threadOpenJournal}</Button>
            <Link href="/practice" className={styles.secondaryLink}>{PRACTICE_COPY.threadStartNew}</Link>
          </div>
        </>
      ) : (
        <>
          <div className={styles.dayActions}>
            {gate ? (
              <div className={styles.resumeAction}>
                <Button client href={`/practice/week?thread=${thread.id}&week=${gate.weekNo}`} variant="primary">{gate.step}</Button>
              </div>
            ) : (
              !finished && (
                <div className={styles.resumeAction}>
                  <ThreadAction summary={summary} plan={plan} onChanged={onChanged} onNewPlan={onNewPlan} />
                </div>
              )
            )}
            {canReplace && <Button disabled={preparing} onClick={onNewPlan}>{PRACTICE_COPY.threadPageReplace}</Button>}
          </div>
          {gate && <p className={hub.muted}>{gate.locked}</p>}
          {finished && <p className={hub.muted}>{PRACTICE_COPY.swingThreadFinished}</p>}
          {planDone && <p className={styles.dayLine}>{planFinishedLine(thread)}</p>}
          <p className={styles.dayLine}>
            {preparing ? (
              preparingHint
            ) : fresh ? (
              PRACTICE_COPY.threadPageFresh
            ) : swing ? (
              <>
                <span className={hub.muted}>{`${view.label}: `}</span>
                {result}
              </>
            ) : (
              result
            )}
          </p>
        </>
      )}
    </section>
  );
}
