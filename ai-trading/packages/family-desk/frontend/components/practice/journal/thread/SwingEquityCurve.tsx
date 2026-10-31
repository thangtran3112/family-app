"use client";

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
  // The higher figure's label sits above its point and the other below, so two close lines do not print on each other.
  const equityAbove = now !== null && now.equity >= now.balance;
  const endLabels: CurveLabel[] =
    now === null
      ? []
      : [
          { x: now.x - 8, y: now.equityY + (equityAbove ? -8 : 16), text: `${HUB_SWING_COPY.curveEquity} ${formatBalance(now.equity)}`, anchor: "end" },
          { x: now.x - 8, y: now.balanceY + (equityAbove ? 16 : -8), text: `${HUB_SWING_COPY.curveBalance} ${formatBalance(now.balance)}`, anchor: "end" },
        ];
  // The start note moves off the end labels when the balance sits near its start ("Starting balance" printed over "Balance $25,000.00" on a live thread).
  const note = startNoteSpot(layout, PRACTICE_COPY.curveStart, endLabels);

  return (
    <div className={styles.stack}>
      <svg viewBox={`0 0 ${BOX.width} ${BOX.height}`} role="img" aria-label={summary} className={styles.chart}>
        {layout.ticks.map((tick) => (
          <g key={tick.value}>
            <line x1={plot.x} x2={plot.x + plot.width} y1={tick.y} y2={tick.y} className={styles.grid} />
            <text x={plot.x - 8} y={tick.y} dy="0.32em" textAnchor="end" className={styles.axis}>{formatAxisDollars(tick.value)}</text>
          </g>
        ))}
        <line x1={plot.x} x2={plot.x + plot.width} y1={layout.startY} y2={layout.startY} className={styles.startLine} />
        <text x={note.x} y={note.y} textAnchor={note.anchor} className={styles.note}>{note.text}</text>
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
        {layout.days.map((point) =>
          point.label ? <text key={point.dayNo} x={point.x} y={bottom + 20} textAnchor={point.dayNo === layout.days[0]?.dayNo ? "start" : "middle"} className={styles.axis}>{point.label}</text> : null,
        )}
        {endLabels[0] && (
          <text x={endLabels[0].x} y={endLabels[0].y} textAnchor="end" className={styles.equityLabel}>{endLabels[0].text}</text>
        )}
        {endLabels[1] && (
          <text x={endLabels[1].x} y={endLabels[1].y} textAnchor="end" className={styles.nowLabel}>{endLabels[1].text}</text>
        )}
      </svg>
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
