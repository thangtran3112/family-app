import { Button } from "@/components/ui/Button";
import { formatEtClock } from "@/lib/desk/format";
import type { Speed } from "@/lib/replay/clock";
import { playerPillText, statusLine, type PlayerStatus } from "@/lib/replay/player";
import type { ReplayMark, ReplaySignal } from "@/lib/replay/schemas";
import { JumpMenu } from "./JumpMenu";
import { ReplayTimeline } from "./ReplayTimeline";
import { SpeedChips } from "./SpeedChips";
import styles from "./replay.module.css";

export type ThreadClockBarProps = {
  /** "Thread time" for a name on a day list, "Replay time" for a session that stands alone. */
  label: string;
  /** What the label means, as a tooltip. */
  hint: string;
  status: PlayerStatus;
  /** A request is in flight: Step waits for its answer (a second press would queue behind it, past a stop pause). */
  busy: boolean;
  speed: Speed;
  error: string | null;
  windowStart: string;
  windowEnd: string;
  /** The thread's one time (`threadClock`): the day's shared clock, never one name's older playhead. */
  clock: string;
  marks: readonly ReplayMark[];
  signals: readonly ReplaySignal[];
  onToggle: () => void;
  onStep: () => void;
  onSpeed: (speed: Speed) => void;
  onJumpBy: (minutes: number) => void;
  onJumpToTime: (hhmm: string) => void;
  onNextSignal: () => void;
  onJumpEnd: () => void;
  /** A swing session (02p): "+1 hour" and "To the close" in the Jump menu. */
  swing?: boolean;
};

/**
 * The thread's clock, across the top of the workspace and above every name's header and chart: play or pause, step, speed,
 * jump, the time itself and the timeline. A day-trade thread has ONE time for all its tickers, so none of this sits under or
 * beside a single chart; what belongs to one name (interval, chart settings, full screen, Buy and Sell) is `ChartToolbar`.
 * Forward-only (02o §a3).
 */
export function ThreadClockBar(props: ThreadClockBarProps) {
  const { status, speed, error, windowStart, windowEnd, clock, marks, signals } = props;
  const locked = status === "loading" || status === "at_end";
  return (
    <section className={styles.threadBar} aria-label={props.label} data-testid="thread-clock">
      <div className={styles.threadRow}>
        <div className={styles.threadTime} title={props.hint}>
          <span className={styles.threadLabel}>{props.label}</span>
          <span className={styles.threadValue} data-testid="thread-clock-time">{formatEtClock(clock)}</span>
          <span className={styles.statePill} data-state={status}>{playerPillText(status, speed)}</span>
        </div>
        <p className={styles.status} role="status" aria-live="polite">{statusLine(status, speed, clock, windowStart)}</p>
      </div>
      <div className={styles.toolbarRow}>
        <Button size="md" variant="primary" disabled={locked} aria-label={status === "playing" ? "Pause" : "Play"} title="Space" onClick={props.onToggle}>
          {status === "playing" ? "Pause" : "Play"}
        </Button>
        <Button size="md" disabled={locked || props.busy} title="Step one bar (→)" onClick={props.onStep}>Step</Button>
        <SpeedChips speed={speed} onSpeed={props.onSpeed} />
        <JumpMenu
          revealedThrough={clock}
          windowEnd={windowEnd}
          disabled={locked}
          onJumpBy={props.onJumpBy}
          onJumpToTime={props.onJumpToTime}
          onNextSignal={props.onNextSignal}
          onJumpEnd={props.onJumpEnd}
          swing={props.swing}
        />
      </div>
      {error && (
        <p className={styles.errorLine} role="alert">
          {error.replace(/ · Try again$/, "")} ·{" "}
          <button type="button" className={styles.linkButton} onClick={props.onToggle}>Try again</button>
        </p>
      )}
      <ReplayTimeline windowStart={windowStart} windowEnd={windowEnd} revealedThrough={clock} marks={marks} signals={signals} />
    </section>
  );
}
