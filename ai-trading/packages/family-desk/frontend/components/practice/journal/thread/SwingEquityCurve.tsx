"use client";

import { MiniChartFrame } from "@/components/charts/MiniChartFrame";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { HUB_SWING_COPY, startNoteSpot, swingCurveLayout, swingCurveSummary, type CurveLabel } from "@/lib/replay/hubSwing";
import type { Box } from "@/lib/replay/threadChart";
import type { SwingState } from "@/lib/replay/threads";
import { formatAxisDollars, formatBalance } from "@/lib/replay/threadView";
import styles from "./threadJournal.module.css";

const BOX: Box = { width: 760, height: 240, left: 76, right: 24, top: 16, bottom: 36 };

/**
 * The balance and the equity at the close of each finished day (02p h): two lines over the whole calendar, so they grow to
 * the right as days end. The balance counts closed holds only; the equity adds the open ones at the last close. Days are
 * numbered, never dated. Both lines are SIMULATED dollars; the colours come from the CSS classes, and the two end labels
 * name the lines so the key below is a repeat, not the only cue.
 */
export function SwingEquityCurve({ state, startingBalance }: { state: SwingState; startingBalance: number }) {
  const layout = swingCurveLayout(state.equity_series, startingBalance, state.days, BOX);
  const { plot, now } = layout;
  const bottom = plot.y + plot.height;
  const summary = swingCurveSummary(state.equity_series, startingBalance, formatBalance);
  // The higher figure's label sits above its point and the other below, so two close lines do not print on each other. A label
  // never goes below a point that rests on the bottom tick: that is the row of the day labels ("Balance $50,000.00" ran into "D5", D-123).
  const equityAbove = now !== null && now.equity >= now.balance;
  const below = (y: number) => y + 16 < bottom - 6;
  const endLabels: CurveLabel[] =
    now === null
      ? []
      : [
          { x: now.x - 8, y: now.equityY + (!equityAbove && below(now.equityY) ? 16 : -8), text: `${HUB_SWING_COPY.curveEquity} ${formatBalance(now.equity)}`, anchor: "end" },
          { x: now.x - 8, y: now.balanceY + (equityAbove && below(now.balanceY) ? 16 : -8), text: `${HUB_SWING_COPY.curveBalance} ${formatBalance(now.balance)}`, anchor: "end" },
        ];
  // The start note moves off the end labels when the balance sits near its start ("Starting balance" printed over "Balance $25,000.00" on a live thread).
  const note = startNoteSpot(layout, PRACTICE_COPY.curveStart, endLabels);

  return (
    <div className={styles.stack}>
      <MiniChartFrame
        box={BOX}
        label={summary}
        yTicks={layout.ticks.map((tick) => ({ key: tick.value, y: tick.y, label: formatAxisDollars(tick.value) }))}
        start={{ y: layout.startY, note }}
      >
        {layout.days.length > 1 && (
          <>
            <path d={layout.equityLine} className={styles.equityLine} />
            <path d={layout.balanceLine} className={styles.line} />
          </>
        )}
        {layout.days.slice(1).map((point) => (
          <g key={point.dayNo}>
            <circle cx={point.x} cy={point.equityY} r={3} className={styles.dotEquity} />
            <circle cx={point.x} cy={point.balanceY} r={3.5} className={point === now ? styles.dotNow : styles.dot} />
          </g>
        ))}
        {layout.xTicks.map((tick, index) => (
          <text key={tick.label} x={tick.x} y={bottom + 20} textAnchor={index === 0 ? "start" : "middle"} className={styles.axis}>{tick.label}</text>
        ))}
        {endLabels[0] && (
          <text x={endLabels[0].x} y={endLabels[0].y} textAnchor="end" className={styles.equityLabel}>{endLabels[0].text}</text>
        )}
        {endLabels[1] && (
          <text x={endLabels[1].x} y={endLabels[1].y} textAnchor="end" className={styles.nowLabel}>{endLabels[1].text}</text>
        )}
      </MiniChartFrame>
      <ul role="list" className={styles.keyList}>
        <li className={styles.legendRow}>
          <span className={`${styles.keyLine} ${styles.keyBalance}`} aria-hidden="true" />
          <span>{HUB_SWING_COPY.curveBalance}</span>
        </li>
        <li className={styles.legendRow}>
          <span className={`${styles.keyLine} ${styles.keyEquity}`} aria-hidden="true" />
          <span>{HUB_SWING_COPY.curveEquity}</span>
        </li>
      </ul>
    </div>
  );
}
