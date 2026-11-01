"use client";

import Link from "next/link";
import { SwingEquityCurve } from "@/components/practice/journal/thread/SwingEquityCurve";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import type { PracticePlan } from "@/lib/replay/daily";
import { HUB_SWING_COPY } from "@/lib/replay/hubSwing";
import { overviewWeekRows, type OverviewWeekRow } from "@/lib/replay/overviewView";
import { freeCashText, holdRowView, swingCardView, swingDatesHidden, type HoldRowView } from "@/lib/replay/swing";
import { loadHolds, loadWeeks } from "@/lib/replay/swingApi";
import type { Thread } from "@/lib/replay/threads";
import { formatBalance, planRows } from "@/lib/replay/threadView";
import { DaysSection, PlaceStrip, StatsPanel } from "./OverviewParts";
import { NextStep } from "./NextStep";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";
import { FactList } from "@/components/ui/FactList";

const tone = (value: HoldRowView["resultTone"] | OverviewWeekRow["realizedTone"]) => o[value];

const WEEK_COLUMNS = (): DenseColumn<OverviewWeekRow>[] => [
  { key: "week", label: "Week", render: (row) => (row.href === null ? row.label : <Link href={row.href} className={o.rowLink}>{row.label}</Link>) },
  { key: "status", label: "Status", render: (row) => <span className={row.status === "upcoming" ? o.pending : undefined}>{row.statusText}</span> },
  { key: "days", label: "Days", align: "right", render: (row) => row.days },
  { key: "realized", label: "Realized", align: "right", render: (row) => <span className={tone(row.realizedTone)}>{row.realized}</span> },
  { key: "equityChange", label: PRACTICE_COPY.landingColEquityChange, align: "right", render: (row) => <span className={tone(row.equityChangeTone)}>{row.equityChange}</span> },
];

type HoldRow = { id: string; view: HoldRowView };
const HOLD_COLUMNS: DenseColumn<HoldRow>[] = [
  { key: "symbol", label: "Symbol", render: ({ view }) => view.symbol },
  { key: "side", label: "Side", render: ({ view }) => view.side },
  { key: "shares", label: "Shares", align: "right", render: ({ view }) => view.shares },
  { key: "held", label: "Days held", render: ({ view }) => view.held },
  { key: "result", label: "Unrealized", align: "right", render: ({ view }) => <span className={tone(view.resultTone)}>{view.result}</span> },
];

/**
 * The overview of a swing thread (5R): where it is (balance, week, day), the one next step (Continue Day n, or the owed week
 * review first), the weeks, the ended days, the open holds, the equity curve, and the plan and stats at the side. Every dollar is
 * SIMULATED; a day is a number and a weekday, never a date.
 */
export function SwingOverview({ summary, plan, onChanged }: { summary: Thread; plan: PracticePlan | null; onChanged: () => void }) {
  const { thread, swing: state } = summary;
  const card = swingCardView(summary);
  // The answers follow the thread's state, so a newly ended day reads again (the journal keys them the same way).
  const stamp = `${thread.id}:${thread.status}:${state?.days_ended ?? 0}`;
  const weeks = useDeskQuery(`swing-weeks:${stamp}`, (signal) => loadWeeks(thread.id, { signal }));
  const holds = useDeskQuery(`swing-holds:${stamp}`, (signal) => loadHolds(thread.id, "open", { signal }));
  if (!state || !card) return null; // the page opens this only for a thread that carries its swing state

  const setup = thread.swing;
  const curve = state.equity_series.length > 0;
  const holdRows: HoldRow[] = (holds.data?.holds ?? []).map((hold) => ({ id: String(hold.id), view: holdRowView(hold, setup?.tape ?? "off") }));

  return (
    <div className={o.grid}>
      <div className={o.main}>
        <PlaceStrip summary={summary}>
          <p className={o.placeLine}>{card.line}</p>
          <p className={hub.muted}>{`${practiceText("swingEquity", { amount: formatBalance(state.equity_usd) })} · ${freeCashText(state.free_cash_usd)}`}</p>
        </PlaceStrip>
        <NextStep summary={summary} plan={plan} onChanged={onChanged} onNewPlan={() => undefined} />

        <section className={`${styles.panel} ${o.tablePanel}`} aria-label={HUB_SWING_COPY.weeksTitle}>
          <div className={o.sectionHead}>
            <h2 className={styles.panelTitle}>{HUB_SWING_COPY.weeksTitle}</h2>
            <SimulatedBadge />
          </div>
          <p className={hub.hint}>{HUB_SWING_COPY.weeksHint}</p>
          {weeks.loading ? (
            <LoadingBlock label="Loading the weeks…" height={96} />
          ) : weeks.data === null ? (
            <ErrorBlock message={HUB_SWING_COPY.weeksLoadError} onRetry={weeks.refresh} />
          ) : (
            <DenseTable caption={PRACTICE_COPY.overviewWeeksCaption} columns={WEEK_COLUMNS()} rows={overviewWeekRows(thread.id, state, weeks.data.weeks)} rowKey={(row) => String(row.weekNo)} />
          )}
        </section>

        <DaysSection daily={summary.daily} equity={{ startingBalance: thread.startingBalance, series: state.equity_series }} />

        <section className={`${styles.panel} ${o.tablePanel}`} aria-label={HUB_SWING_COPY.holdsTitle}>
          <div className={o.sectionHead}>
            <h2 className={styles.panelTitle}>{HUB_SWING_COPY.holdsTitle}</h2>
            <span className={hub.chip}>{practiceText("overviewHoldsCount", { n: state.holds_open })}</span>
          </div>
          <p className={hub.hint}>{HUB_SWING_COPY.holdsHint}</p>
          {holds.loading ? (
            <LoadingBlock label="Loading the holds…" height={96} />
          ) : holds.data === null ? (
            <ErrorBlock message={HUB_SWING_COPY.holdsLoadError} onRetry={holds.refresh} />
          ) : (
            <DenseTable caption={PRACTICE_COPY.overviewHoldsCaption} columns={HOLD_COLUMNS} rows={holdRows} rowKey={(row) => row.id} empty={PRACTICE_COPY.swingNoHoldsOpen} />
          )}
          <Link href={`/practice/journal?thread=${thread.id}`} className={styles.textLink}>{PRACTICE_COPY.overviewHoldsLink}</Link>
        </section>

        <section className={styles.panel} aria-label={PRACTICE_COPY.overviewCurveTitle}>
          <div className={o.sectionHead}>
            <h2 className={styles.panelTitle}>{PRACTICE_COPY.swingEquityTitle}</h2>
            <SimulatedBadge />
          </div>
          {curve ? (
            <>
              <SwingEquityCurve state={state} startingBalance={thread.startingBalance} />
              <p className={hub.hint}>{HUB_SWING_COPY.curveLine}</p>
            </>
          ) : (
            <p className={hub.muted}>{HUB_SWING_COPY.noDaysYet}</p>
          )}
        </section>
      </div>

      <div className={o.side}>
        <section className={styles.panel} aria-label={PRACTICE_COPY.overviewPlanCaption}>
          <h2 className={styles.panelTitle}>{PRACTICE_COPY.overviewPlanTitle}</h2>
          <p className={styles.dayLine}>{card.title}</p>
          {setup && swingDatesHidden(setup) && <p className={hub.muted}>{HUB_SWING_COPY.dateHidden}</p>}
          <FactList facts={planRows(thread.plan, "swing").map((row) => ({ id: row.id, label: row.label, value: row.value }))} />
        </section>
        <StatsPanel thread={thread} />
      </div>
    </div>
  );
}
