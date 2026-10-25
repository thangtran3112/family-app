import { SPEEDS, type Speed } from "@/lib/replay/clock";
import styles from "./replay.module.css";

/** 1x 2x 5x 10x. Keys 1 to 4 pick them in order. */
export function SpeedChips({ speed, onSpeed }: { speed: Speed; onSpeed: (speed: Speed) => void }) {
  return (
    <div className={styles.chips} role="group" aria-label="Replay speed">
      {SPEEDS.map((value, index) => (
        <button
          key={value}
          type="button"
          className={styles.chipButton}
          aria-pressed={speed === value}
          title={`${value}x speed (key ${index + 1})`}
          onClick={() => onSpeed(value)}
        >
          {value}x
        </button>
      ))}
    </div>
  );
}
