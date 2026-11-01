import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { ChipToggleGroup } from "@/components/ui/ChipToggleGroup";
import type { Speed } from "@/lib/replay/clock";
import { KEY_LEGEND } from "@/lib/replay/keys";
import { statusLine, type PlayerStatus } from "@/lib/replay/player";
import type { ReplayInterval, ReplayMark, ReplaySignal } from "@/lib/replay/schemas";
import { INTERVALS } from "@/lib/replay/setup";
import { JumpMenu } from "./JumpMenu";
import { ReplayTimeline } from "./ReplayTimeline";
import { SpeedChips } from "./SpeedChips";
import styles from "./replay.module.css";

const INTERVAL_CHIPS = INTERVALS.map((value) => ({ id: value, label: value, title: `${value} candles` }));

export type TransportBarProps = {
  status: PlayerStatus;
  /** A request is in flight: Step waits for its answer (a second press would queue behind it, past a stop pause). */
  busy: boolean;
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
  /** The view controls after the interval chips: Chart settings and Full screen (same slot inline and full screen, so focus stays put). */
  view?: ReactNode;
};

/** Forward-only controls under the chart (02o §a3): play or pause, step, speed, jump, and the timeline. */
export function TransportBar(props: TransportBarProps) {
  const { status, speed, error, windowStart, windowEnd, revealedThrough, marks, signals } = props;
  const locked = status === "loading" || status === "at_end";
  return (
    <div className={styles.transport}>
      <div className={styles.transportRow}>
        <Button size="md" variant="primary" disabled={locked} aria-label={status === "playing" ? "Pause" : "Play"} title="Space" onClick={props.onToggle}>
          {status === "playing" ? "Pause" : "Play"}
        </Button>
        <Button size="md" disabled={locked || props.busy} title="Step one bar (→)" onClick={props.onStep}>Step</Button>
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
          <ChipToggleGroup label="Chart interval" options={INTERVAL_CHIPS} pressed={[props.interval]} onToggle={props.onInterval} />
        )}
        {props.view}
        <p className={styles.status} role="status" aria-live="polite">{statusLine(status, speed, revealedThrough, windowStart)}</p>
      </div>
      {error && (
        <p className={styles.errorLine} role="alert">
          {error.replace(/ · Try again$/, "")} ·{" "}
          <button type="button" className={styles.linkButton} onClick={props.onToggle}>Try again</button>
        </p>
      )}
      <ReplayTimeline windowStart={windowStart} windowEnd={windowEnd} revealedThrough={revealedThrough} marks={marks} signals={signals} />
      <div className={styles.keyLegend} role="group" aria-label="Keyboard legend">
        {KEY_LEGEND.map((item) => (
          <span key={item.keys}><kbd>{item.keys}</kbd>{item.label}</span>
        ))}
      </div>
    </div>
  );
}
