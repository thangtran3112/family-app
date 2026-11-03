"use client";

import { MiniChartFrame } from "@/components/charts/MiniChartFrame";
import { useChartBox } from "@/lib/desk/useChartBox";
import { practiceText } from "@/lib/desk/freshness";
import { barsLayout, dayTickStep, type Box } from "@/lib/replay/threadChart";
import { dayResultTone, formatAxisDollars, formatDayResult } from "@/lib/replay/threadView";
import type { Thread } from "@/lib/replay/threads";
import styles from "./threadJournal.module.css";

const BOX: Box = { width: 760, height: 220, left: 64, right: 24, top: 16, bottom: 28 };

/** The result of each ET date as bars from zero (02r board P8; ADR-0025): green won, red lost. One bar per date with a closed trade; a date is a label, not a boundary. */
export function DateBars({ thread }: { thread: Thread }) {
  const [ref, box] = useChartBox(BOX);
  const layout = barsLayout(thread.daily, box);
  const { plot, zeroY, slots } = layout;
  const bottom = plot.y + plot.height;
  const won = thread.daily.filter((date) => date.pnl_usd > 0).length;
  const lost = thread.daily.filter((date) => date.pnl_usd < 0).length;
  const summary = practiceText("journalBarsSummary", { won, lost });
  // The date labels sit at one regular step once there are too many bars to name them all.
  const step = dayTickStep(slots.length);

  return (
    <div ref={ref}>
      <MiniChartFrame
        box={box}
        label={summary}
        yTicks={layout.ticks.map((tick) => ({ key: tick.value, y: tick.y, label: formatAxisDollars(tick.value, true) }))}
        xLabels={slots.filter((_, index) => index % step === 0).map((slot) => ({ x: slot.center, label: slot.label }))}
      >
        <line x1={plot.x} x2={plot.x + plot.width} y1={zeroY} y2={zeroY} className={styles.zeroLine} />
        {slots.map((slot) => {
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
      </MiniChartFrame>
    </div>
  );
}
