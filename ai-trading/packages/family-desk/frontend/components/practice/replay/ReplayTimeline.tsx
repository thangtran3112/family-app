import { timelineModel } from "@/lib/replay/timeline";
import type { ReplayMark, ReplaySignal } from "@/lib/replay/schemas";
import { formatEtTimeZone } from "@/lib/desk/format";
import styles from "./replay.module.css";

export type ReplayTimelineProps = {
  windowStart: string;
  windowEnd: string;
  revealedThrough: string;
  marks: readonly ReplayMark[];
  signals: readonly ReplaySignal[];
};

/** Forward-only timeline: the revealed part is filled and carries ticks for her marks and released signals; the future is empty. */
export function ReplayTimeline({ windowStart, windowEnd, revealedThrough, marks, signals }: ReplayTimelineProps) {
  const model = timelineModel(windowStart, windowEnd, revealedThrough, marks, signals);
  const percent = Math.round(model.revealed * 100);
  return (
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
      {model.ticks.map((tick, index) => (
        <span key={`${tick.kind}-${index}`} className={styles.tick} data-kind={tick.kind} style={{ left: `${tick.at * 100}%` }} title={tick.label} />
      ))}
    </div>
  );
}
