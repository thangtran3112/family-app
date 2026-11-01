"use client";

import { useId } from "react";
import { MiniChartFrame } from "@/components/charts/MiniChartFrame";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { startNoteSpot, type CurveLabel } from "@/lib/replay/hubSwing";
import { curveLayout, type Box } from "@/lib/replay/threadChart";
import { formatAxisDollars, formatBalance } from "@/lib/replay/threadView";
import type { Thread } from "@/lib/replay/threads";
import styles from "./threadJournal.module.css";

// `left` leaves the y labels their own room inside the card (they used to reach 7 px into its padding).
const BOX: Box = { width: 760, height: 240, left: 76, right: 24, top: 16, bottom: 36 };

/** The balance at the end of each day (02r board P8). Practiced days are solid dots, skipped days open circles, the newest
 *  point amber; the red shading is the part of the line below the starting balance. Colours come from the CSS classes. */
export function BalanceCurve({ thread }: { thread: Thread }) {
  const clipId = `below-start-${useId().replace(/\W/g, "")}`;
  const { startingBalance, stats } = thread.thread;
  const layout = curveLayout(thread.curve, thread.daily, startingBalance, BOX);
  const { plot, startY, points, lowest, now } = layout;
  const bottom = plot.y + plot.height;
  const last = points.length - 1;
  const drawn = points.length > 1;
  // ponytail: x labels thinned to about 20 at most; per-point labels crowd past that. Upgrade: a responsive axis.
  const every = Math.max(1, Math.ceil(points.length / 20));
  const lowRight = lowest !== null && lowest.x > plot.x + plot.width - 80;
  // When the newest point is also the lowest, "Now" already says it: a second label on the same spot would print over it.
  const lowIsNow = lowest !== null && now !== null && lowest.x === now.x && lowest.y === now.y;
  const lowText = lowest ? `lowest ${formatBalance(lowest.balance)}` : "never below the start";
  // The start note moves off the "Now" and "Lowest" labels, as on the swing curve (it printed over them on a live thread).
  const others: CurveLabel[] = [
    ...(now ? [{ x: now.x - 8, y: now.y - 8, text: `Now ${formatBalance(now.balance)}`, anchor: "end" as const }] : []),
    ...(lowest && !lowIsNow ? [{ x: lowest.x, y: lowest.y + 16 < bottom - 6 ? lowest.y + 16 : lowest.y - 8, text: `Lowest ${formatBalance(lowest.balance)}`, anchor: lowRight ? ("end" as const) : ("start" as const) }] : []),
  ];
  const note = startNoteSpot(layout, PRACTICE_COPY.curveStart, others);
  const summary = `Balance at the end of each day. Starts at ${formatBalance(startingBalance)}, now ${formatBalance(stats.balance)}, ${lowText}.`;

  return (
    <MiniChartFrame
      box={BOX}
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
            <circle key={point.n} cx={point.x} cy={point.y} r={3.5} className={point.skipped ? styles.dotOpen : styles.dot} />
          ),
        )}
      {points.map((point, index) =>
        index % every === 0 || index === last ? (
          <text key={point.n} x={point.x} y={bottom + 20} textAnchor={index === 0 ? "start" : "middle"} className={styles.axis}>{point.label}</text>
        ) : null,
      )}
      {now && (
        <text x={now.x - 8} y={now.y - 8} textAnchor="end" className={styles.nowLabel}>{`Now ${formatBalance(now.balance)}`}</text>
      )}
      {lowest && !lowIsNow && (
        <text
          x={lowest.x}
          y={lowest.y + 16 < bottom - 6 ? lowest.y + 16 : lowest.y - 8}
          textAnchor={lowRight ? "end" : "middle"}
          className={styles.lowLabel}
        >
          {`Lowest ${formatBalance(lowest.balance)}`}
        </text>
      )}
    </MiniChartFrame>
  );
}
