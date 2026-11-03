"use client";

import { useId } from "react";
import { MiniChartFrame } from "@/components/charts/MiniChartFrame";
import { useChartBox } from "@/lib/desk/useChartBox";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { shortDate } from "@/lib/replay/journalView";
import { curveLayout, dayTickStep, endLabelSpots, placeLabel, startNoteSpot, type Box, type CurveLabel } from "@/lib/replay/threadChart";
import { formatAxisDollars, formatBalance } from "@/lib/replay/threadView";
import type { Thread } from "@/lib/replay/threads";
import styles from "./threadJournal.module.css";

// `left` leaves the y labels their own room inside the card (they used to reach 7 px into its padding).
const BOX: Box = { width: 760, height: 240, left: 76, right: 24, top: 16, bottom: 36 };

/** The balance after each ET date that closed a trade (02r board P8; ADR-0025). The newest point is amber; the red shading is the part of the line below
 *  the starting balance. A position still open is not in it. Colours come from the CSS classes. */
export function BalanceCurve({ thread }: { thread: Thread }) {
  const [ref, box] = useChartBox(BOX);
  const clipId = `below-start-${useId().replace(/\W/g, "")}`;
  const { startingBalance, stats } = thread.thread;
  const layout = curveLayout(thread.curve, startingBalance, box);
  const { plot, startY, points, lowest, now } = layout;
  const bottom = plot.y + plot.height;
  const last = points.length - 1;
  const drawn = points.length > 1;
  // The x labels sit at one regular step ("Start", 03-05, 03-10 ...): no odd one out beside "Start".
  const step = dayTickStep(last);
  const lowRight = lowest !== null && lowest.x > plot.x + plot.width - 80;
  // When the newest point is also the lowest, "After ..." already says it: a second label on the same spot would print over it.
  const lowIsNow = lowest !== null && now !== null && lowest.x === now.x && lowest.y === now.y;
  const nowText = now ? practiceText("journalCurveAfter", { date: shortDate(now.day), balance: formatBalance(now.balance) }) : "";
  const lowText = lowest ? `lowest ${formatBalance(lowest.balance)}` : "never below the start";
  // "Lowest" first, then the "After ..." label keeps off it and off the line, then the start note keeps off both (D-181). A label never leaves the plot box:
  // after the first date the newest point is at its left edge, so it goes to the right.
  const lowLabel: CurveLabel | null = lowest && !lowIsNow ? { x: lowest.x, y: lowest.y + 16 < bottom - 6 ? lowest.y + 16 : lowest.y - 8, text: `Lowest ${formatBalance(lowest.balance)}`, anchor: lowRight ? "end" : "start" } : null;
  const lines = [points.map((point) => ({ x: point.x, y: point.y }))];
  const nowLabel = now ? placeLabel(endLabelSpots(now, nowText), { plot, lines, others: lowLabel ? [lowLabel] : [] }) : null;
  const note = startNoteSpot(layout, PRACTICE_COPY.curveStart, [nowLabel, lowLabel].filter((label): label is CurveLabel => label !== null), lines);
  const summary = `Balance after each ET date. Starts at ${formatBalance(startingBalance)}, ${now ? `after ${shortDate(now.day)} ${formatBalance(now.balance)}` : `now ${formatBalance(stats.balance)}`}, ${lowText}.`;

  return (
    <div ref={ref}>
      <MiniChartFrame
        box={box}
        label={summary}
        yTicks={layout.ticks.map((tick) => ({ key: tick.value, y: tick.y, label: formatAxisDollars(tick.value) }))}
        start={{ y: startY, note }}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={plot.x} y={startY} width={plot.width} height={bottom - startY} />
          </clipPath>
        </defs>
        {drawn && (
          <>
            <path d={layout.area} clipPath={`url(#${clipId})`} className={styles.below} />
            <path d={layout.line} className={styles.line} />
          </>
        )}
        {drawn &&
          points.map((point, index) =>
            index === last && point.n > 0 ? (
              <circle key={point.n} cx={point.x} cy={point.y} r={4.5} className={styles.dotNow} />
            ) : (
              <circle key={point.n} cx={point.x} cy={point.y} r={3.5} className={styles.dot} />
            ),
          )}
        {points.map((point, index) =>
          point.n % step === 0 ? (
            <text key={point.n} x={point.x} y={bottom + 20} textAnchor={index === 0 ? "start" : "middle"} className={styles.axis}>{point.label}</text>
          ) : null,
        )}
        {nowLabel && (
          <text x={nowLabel.x} y={nowLabel.y} textAnchor={nowLabel.anchor} className={styles.nowLabel}>{nowLabel.text}</text>
        )}
        {lowLabel && (
          <text x={lowLabel.x} y={lowLabel.y} textAnchor={lowRight ? "end" : "middle"} className={styles.lowLabel}>{lowLabel.text}</text>
        )}
      </MiniChartFrame>
    </div>
  );
}
