"use client";

import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { barsLayout, type Box } from "@/lib/replay/threadChart";
import { dayResultTone, formatDayResult, weeksOf } from "@/lib/replay/threadView";
import type { Thread } from "@/lib/replay/threads";
import styles from "./threadJournal.module.css";

const BOX: Box = { width: 760, height: 220, left: 64, right: 24, top: 16, bottom: 44 };

/** The result of each day as bars from zero (02r board P8): green won, red lost, a dashed box for a skipped day. */
export function DayBars({ thread }: { thread: Thread }) {
  const layout = barsLayout(thread.daily, weeksOf(thread.daily), BOX);
  const { plot, zeroY, slots, weeks } = layout;
  const bottom = plot.y + plot.height;
  const practised = thread.daily.filter((day) => day.kind === "practiced");
  const won = practised.filter((day) => day.pnl_usd > 0).length;
  const lost = practised.filter((day) => day.pnl_usd < 0).length;
  const skipped = thread.daily.length - practised.length;
  const summary = `${PRACTICE_COPY.barsTitle}: ${won} won, ${lost} lost, ${skipped} skipped.`;

  return (
    <svg viewBox={`0 0 ${BOX.width} ${BOX.height}`} role="img" aria-label={summary} className={styles.chart}>
      {layout.ticks.map((tick) => (
        <g key={tick.value}>
          <line x1={plot.x} x2={plot.x + plot.width} y1={tick.y} y2={tick.y} className={styles.grid} />
          <text x={plot.x - 8} y={tick.y} dy="0.32em" textAnchor="end" className={styles.axis}>{formatDayResult(tick.value)}</text>
        </g>
      ))}
      <line x1={plot.x} x2={plot.x + plot.width} y1={zeroY} y2={zeroY} className={styles.zeroLine} />
      {slots.map((slot) => {
        if (slot.kind === "skipped") {
          return (
            <g key={slot.n}>
              <rect x={slot.x} y={plot.y} width={slot.width} height={plot.height} className={styles.skipBox} />
              <text x={slot.center} y={zeroY} dy="0.32em" textAnchor="middle" className={styles.skipLabel}>{PRACTICE_COPY.threadSkipped}</text>
            </g>
          );
        }
        const tone = dayResultTone(slot.value);
        return (
          <g key={slot.n}>
            {tone !== "flat" && <rect x={slot.x} y={slot.barY} width={slot.width} height={slot.barHeight} className={styles[tone]} />}
            <text
              x={slot.center}
              y={tone === "down" ? (slot.barY + slot.barHeight + 12 <= bottom ? slot.barY + slot.barHeight + 12 : zeroY - 4) : slot.barY - 4}
              textAnchor="middle"
              className={`${styles.valueLabel} ${styles[tone]}`}
            >
              {formatDayResult(slot.value)}
            </text>
          </g>
        );
      })}
      {slots.map((slot) => (
        <text key={slot.n} x={slot.center} y={bottom + 14} textAnchor="middle" className={styles.axis}>{slot.label}</text>
      ))}
      {weeks.map((week) => (
        <g key={week.n}>
          <line x1={week.x1} x2={week.x2} y1={bottom + 24} y2={bottom + 24} className={styles.hairline} />
          <text x={(week.x1 + week.x2) / 2} y={bottom + 38} textAnchor="middle" className={styles.axis}>{week.label}</text>
        </g>
      ))}
    </svg>
  );
}
