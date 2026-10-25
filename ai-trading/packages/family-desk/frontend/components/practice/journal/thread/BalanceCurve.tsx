"use client";

import { useId } from "react";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { curveLayout, type Box } from "@/lib/replay/threadChart";
import { formatAxisDollars, formatBalance } from "@/lib/replay/threadView";
import type { Thread } from "@/lib/replay/threads";
import styles from "./threadJournal.module.css";

const BOX: Box = { width: 760, height: 240, left: 64, right: 24, top: 16, bottom: 32 };

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
  const summary = `Balance at the end of each day. Starts at ${formatBalance(startingBalance)}, now ${formatBalance(stats.balance)}, ${lowText}.`;

  return (
    <svg viewBox={`0 0 ${BOX.width} ${BOX.height}`} role="img" aria-label={summary} className={styles.chart}>
      <defs>
        <clipPath id={clipId}>
          <rect x={plot.x} y={startY} width={plot.width} height={bottom - startY} />
        </clipPath>
      </defs>
      {layout.ticks.map((tick) => (
        <g key={tick.value}>
          <line x1={plot.x} x2={plot.x + plot.width} y1={tick.y} y2={tick.y} className={styles.grid} />
          <text x={plot.x - 8} y={tick.y} dy="0.32em" textAnchor="end" className={styles.axis}>{formatAxisDollars(tick.value)}</text>
        </g>
      ))}
      <line x1={plot.x} x2={plot.x + plot.width} y1={startY} y2={startY} className={styles.startLine} />
      <text x={plot.x + 6} y={startY - 6} className={styles.note}>{PRACTICE_COPY.curveStart}</text>
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
          <text key={point.n} x={point.x} y={bottom + 16} textAnchor="middle" className={styles.axis}>{point.label}</text>
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
    </svg>
  );
}
