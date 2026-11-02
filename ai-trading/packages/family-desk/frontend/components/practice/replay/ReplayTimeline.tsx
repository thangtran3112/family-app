import { timelineModel } from "@/lib/replay/timeline";
import type { ReplayMark, ReplaySignal } from "@/lib/replay/schemas";
import { formatEtTime, formatEtTimeZone } from "@/lib/desk/format";
import styles from "./replay.module.css";

export type ReplayTimelineProps = {
  windowStart: string;
  windowEnd: string;
  /** Where her plan's practice window ends: a mark on the line, never a stop. */
  focusEnd?: string | null;
  revealedThrough: string;
  marks: readonly ReplayMark[];
  signals: readonly ReplaySignal[];
};

/** Forward-only timeline: the revealed part is filled and carries ticks for her marks and released signals; the future is empty.
 *  The end labels name the window's clock times and the legend names the two tick colours (D-026). */
export function ReplayTimeline({ windowStart, windowEnd, focusEnd = null, revealedThrough, marks, signals }: ReplayTimelineProps) {
  const model = timelineModel(windowStart, windowEnd, revealedThrough, marks, signals);
  const focus = focusEnd === null ? null : timelineModel(windowStart, windowEnd, focusEnd, [], []).revealed;
  const percent = Math.round(model.revealed * 100);
  return (
    <div className={styles.timelineWrap}>
      <div
        className={styles.timeline}
        role="progressbar"
        aria-label="Replay progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`Revealed through ${formatEtTimeZone(revealedThrough)}`}
      >
        <div className={styles.timelineFill} style={{ width: `${model.revealed * 100}%` }} />
        {focus !== null && focus < 1 && <span className={styles.tick} data-kind="focus" style={{ left: `${focus * 100}%` }} title={`Your practice window ends ${formatEtTime(focusEnd ?? "")} · the clock does not stop there`} />}
        {model.ticks.map((tick, index) => (
          <span key={`${tick.kind}-${index}`} className={styles.tick} data-kind={tick.kind} style={{ left: `${tick.at * 100}%` }} title={tick.label} />
        ))}
      </div>
      <div className={styles.timelineLabels}>
        <span>{formatEtTime(windowStart)}</span>
        <span className={styles.tickLegend}>
          <i className={styles.tickKey} data-kind="signal" aria-hidden="true" /> signal released · <i className={styles.tickKey} data-kind="mark" aria-hidden="true" /> your mark
        </span>
        <span>{formatEtTime(windowEnd)}</span>
      </div>
    </div>
  );
}
