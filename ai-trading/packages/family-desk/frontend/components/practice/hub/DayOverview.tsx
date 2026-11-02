"use client";

import { BalanceCurve } from "@/components/practice/journal/thread/BalanceCurve";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { PracticePlan } from "@/lib/replay/daily";
import { useDayDateShown } from "@/lib/replay/dateShown";
import { datesHidden, planCard } from "@/lib/replay/dayView";
import type { Thread } from "@/lib/replay/threads";
import { hasNoDays } from "@/lib/replay/threadView";
import type { ThreadClockApi } from "@/lib/replay/useThreadClock";
import { NextStep } from "./NextStep";
import { DaysSection, PlaceStrip, StatsPanel } from "./OverviewParts";
import { ThreadClockPanel } from "./ThreadClockPanel";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/**
 * The overview of a day thread (5R): the balance and the day it is on, Open Day n with the daily plan right beside it (so what is
 * armed is above the fold), the history of ended days, the balance curve, and the stats at the side. Every dollar is SIMULATED.
 */
export function DayOverview({ summary, plan, onChanged, onNewPlan, clock }: { summary: Thread; plan: PracticePlan | null; onChanged: () => void; onNewPlan: () => void; clock: ThreadClockApi }) {
  const { thread } = summary;
  const closed = thread.status === "closed";
  // The plan of this thread (a plan bound to another thread is not shown here), with its cursor: "Day 2 of 5 · next: Mon".
  const planHere = plan !== null && plan.thread_id === thread.id ? plan : null;
  const card = planCard(planHere);
  // One account at the clock feeds the headline, the Today row and the clock card (D-169).
  const account = closed ? null : (clock.clock?.account ?? null);
  // The date shows once Show date was pressed on this day's chart band (D-174); no plan read yet counts as hidden: a date shown too early cannot be taken back (D-155).
  const dateShown = useDayDateShown(clock.clock?.day_list_id ?? null);
  const hidden = (planHere === null || datesHidden(planHere.spec)) && !dateShown;
  // The data is still being prepared: the Today card says so, once (D-176).
  const preparing = card.action === "none";

  return (
    <div className={o.grid}>
      <div className={o.main}>
        <PlaceStrip summary={summary} planFinished={planHere?.finished === true} account={account} />
        {!closed && <ThreadClockPanel api={clock} datesHidden={hidden} preparing={preparing} onSkipped={onChanged} />}
        <div className={o.topRow}>
          <NextStep summary={summary} plan={plan} account={account} onChanged={onChanged} onNewPlan={onNewPlan} />
          {planHere && !closed && (
            <section className={styles.panel} aria-label="Daily list plan">
              <h2 className={styles.panelTitle}>{PRACTICE_COPY.planTitle}</h2>
              {!preparing && <p className={styles.dayLine}>{card.headline}</p>}
              {!preparing && card.detail && <p className={hub.muted}>{card.detail}</p>}
              <p className={hub.muted}>{planHere.filters.map((filter) => filter.name).join(" · ")}</p>
            </section>
          )}
        </div>
        <DaysSection daily={summary.daily} />
        {!hasNoDays(summary) && (
          <section className={styles.panel} aria-label={PRACTICE_COPY.overviewCurveTitle}>
            <div className={o.sectionHead}>
              <h2 className={styles.panelTitle}>{PRACTICE_COPY.overviewCurveTitle}</h2>
              <SimulatedBadge />
            </div>
            <BalanceCurve thread={summary} />
          </section>
        )}
      </div>
      <div className={o.side}>
        <StatsPanel thread={thread} />
      </div>
    </div>
  );
}
