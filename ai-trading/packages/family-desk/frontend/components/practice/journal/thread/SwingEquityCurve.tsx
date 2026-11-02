"use client";

import { MiniChartFrame } from "@/components/charts/MiniChartFrame";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { useChartBox } from "@/lib/desk/useChartBox";
import { HUB_SWING_COPY, endLabelSpots, placeLabel, startNoteSpot, swingCurveLayout, swingCurveSummary, type CurveLabel } from "@/lib/replay/hubSwing";
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
  const [ref, box] = useChartBox(BOX);
  const layout = swingCurveLayout(state.equity_series, startingBalance, state.days, box);
  const { plot, now } = layout;
  const bottom = plot.y + plot.height;
  const summary = swingCurveSummary(state.equity_series, startingBalance, formatBalance);
  // The two series as lines of points: the end labels and the start note keep off them (D-181) as well as off each other.
  const lines = [layout.days.map((point) => ({ x: point.x, y: point.equityY })), layout.days.map((point) => ({ x: point.x, y: point.balanceY }))];
  // The higher figure's label prefers a spot above its point and the other below, so two close lines do not print on each other; each
  // label then keeps inside the plot box and off both series, so a point on the bottom tick never pushes one into the day labels (D-123).
  const equityAbove = now !== null && now.equity >= now.balance;
  const equityLabel =
    now === null ? null : placeLabel(endLabelSpots({ x: now.x, y: now.equityY }, `${HUB_SWING_COPY.curveEquity} ${formatBalance(now.equity)}`, equityAbove), { plot, lines });
  const balanceLabel =
    now === null ? null : placeLabel(endLabelSpots({ x: now.x, y: now.balanceY }, `${HUB_SWING_COPY.curveBalance} ${formatBalance(now.balance)}`, !equityAbove), { plot, lines, others: equityLabel ? [equityLabel] : [] });
  const endLabels: CurveLabel[] = [equityLabel, balanceLabel].filter((label): label is CurveLabel => label !== null);
  // The start note moves off the end labels and the lines ("Starting balance" printed over "Balance $25,000.00" on a live thread, and the dashed Equity line and its markers crossed it).
  const note = startNoteSpot(layout, PRACTICE_COPY.curveStart, endLabels, lines);

  return (
    <div ref={ref} className={styles.stack}>
      <MiniChartFrame
        box={box}
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
        {equityLabel && (
          <text x={equityLabel.x} y={equityLabel.y} textAnchor={equityLabel.anchor} className={styles.equityLabel}>{equityLabel.text}</text>
        )}
        {balanceLabel && (
          <text x={balanceLabel.x} y={balanceLabel.y} textAnchor={balanceLabel.anchor} className={styles.nowLabel}>{balanceLabel.text}</text>
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
