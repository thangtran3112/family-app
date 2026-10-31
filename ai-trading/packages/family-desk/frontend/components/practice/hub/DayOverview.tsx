"use client";

import { BalanceCurve } from "@/components/practice/journal/thread/BalanceCurve";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { PracticePlan } from "@/lib/replay/daily";
import { planArmedText, planCard } from "@/lib/replay/dayView";
import type { Thread } from "@/lib/replay/threads";
import { hasNoDays } from "@/lib/replay/threadView";
import { NextStep } from "./NextStep";
import { DaysSection, PlaceStrip, StatsPanel } from "./OverviewParts";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/**
 * The overview of a day thread (5R): the balance and the day it is on, Resume with the daily plan right beside it (so what is
 * armed is above the fold), the history of ended days, the balance curve, and the stats at the side. Every dollar is SIMULATED.
 */
export function DayOverview({ summary, plan, onChanged, onNewPlan }: { summary: Thread; plan: PracticePlan | null; onChanged: () => void; onNewPlan: () => void }) {
  const { thread } = summary;
  const closed = thread.status === "closed";
  // The plan of this thread (a plan bound to another thread is not shown here), with its cursor: "Day 2 of 5 · next: Mon".
  const planHere = plan !== null && plan.thread_id === thread.id ? plan : null;
  const card = planCard(planHere);

  return (
    <div className={o.grid}>
      <div className={o.main}>
        <PlaceStrip summary={summary} planFinished={planHere?.finished === true} />
        <div className={o.topRow}>
          <NextStep summary={summary} plan={plan} onChanged={onChanged} onNewPlan={onNewPlan} />
          {planHere && !closed && (
            <section className={styles.panel} aria-label="Daily list plan">
              <h2 className={styles.panelTitle}>{PRACTICE_COPY.planTitle}</h2>
              <p className={styles.dayLine}>{card.headline}</p>
              {card.detail && <p className={hub.muted}>{card.detail}</p>}
              <p className={hub.muted}>{planHere.filters.map((filter) => filter.name).join(" · ")}</p>
              <p className={hub.muted}>{planArmedText(planHere)}</p>
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
