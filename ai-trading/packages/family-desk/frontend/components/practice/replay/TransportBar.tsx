import type { ReactNode } from "react";
import type { Speed } from "@/lib/replay/clock";
import { statusLine, type PlayerStatus } from "@/lib/replay/player";
import type { ReplayInterval, ReplayMark, ReplaySignal } from "@/lib/replay/schemas";
import { INTERVALS } from "@/lib/replay/setup";
import { JumpMenu } from "./JumpMenu";
import { ReplayTimeline } from "./ReplayTimeline";
import { SpeedChips } from "./SpeedChips";
import styles from "./replay.module.css";

export type TransportBarProps = {
  status: PlayerStatus;
  speed: Speed;
  error: string | null;
  windowStart: string;
  windowEnd: string;
  revealedThrough: string;
  marks: readonly ReplayMark[];
  signals: readonly ReplaySignal[];
  interval: ReplayInterval;
  onInterval: (interval: ReplayInterval) => void;
  onToggle: () => void;
  onStep: () => void;
  onSpeed: (speed: Speed) => void;
  onJumpBy: (minutes: number) => void;
  onJumpToTime: (hhmm: string) => void;
  onNextSignal: () => void;
  onJumpEnd: () => void;
  /** At the 1180 band the practice buttons live here so they work with the drawer closed. */
  quick?: ReactNode;
  /** A swing session (02p): "+1 hour" and "To the close" in the Jump menu, and `chartToggle` in place of the 1m 5m 15m chips. */
  swing?: boolean;
  chartToggle?: ReactNode;
};

/** Forward-only controls under the chart (02o §a3): play or pause, step, speed, jump, and the timeline. */
export function TransportBar(props: TransportBarProps) {
  const { status, speed, error, windowStart, windowEnd, revealedThrough, marks, signals } = props;
  const locked = status === "loading" || status === "at_end";
  return (
    <div className={styles.transport}>
      <div className={styles.transportRow}>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={locked} aria-label={status === "playing" ? "Pause" : "Play"} title="Space" onClick={props.onToggle}>
          {status === "playing" ? "Pause" : "Play"}
        </button>
        <button type="button" className={styles.button} disabled={locked} title="Step one bar (→)" onClick={props.onStep}>Step</button>
        <SpeedChips speed={speed} onSpeed={props.onSpeed} />
        <JumpMenu
          revealedThrough={revealedThrough}
          windowEnd={windowEnd}
          disabled={locked}
          onJumpBy={props.onJumpBy}
          onJumpToTime={props.onJumpToTime}
          onNextSignal={props.onNextSignal}
          onJumpEnd={props.onJumpEnd}
          swing={props.swing}
        />
        {props.quick}
        {props.chartToggle ?? (
          <div className={styles.chips} role="group" aria-label="Chart interval">
            {INTERVALS.map((value) => (
              <button key={value} type="button" className={styles.chipButton} aria-pressed={props.interval === value} title={`${value} candles`} onClick={() => props.onInterval(value)}>
                {value}
              </button>
            ))}
          </div>
        )}
        <p className={styles.status} role="status" aria-live="polite">{statusLine(status, speed, revealedThrough, windowStart)}</p>
      </div>
      {error && (
        <p className={styles.errorLine} role="alert">
          {error.replace(/ · Try again$/, "")} ·{" "}
          <button type="button" className={styles.linkButton} onClick={props.onToggle}>Try again</button>
        </p>
      )}
      <ReplayTimeline windowStart={windowStart} windowEnd={windowEnd} revealedThrough={revealedThrough} marks={marks} signals={signals} />
    </div>
  );
}
