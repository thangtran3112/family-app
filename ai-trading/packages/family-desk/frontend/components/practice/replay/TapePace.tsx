import type { PaceView } from "@/lib/replay/feedState";
import { paceLevel, paceText } from "@/lib/replay/tape";
import styles from "./panels.module.css";

/** A thin pace meter (0 to 1) and its words: "12 prints/s · 3,400 sh/s · Busy · 1.8x avg". */
export function TapePace({ pace }: { pace: PaceView | null }) {
  const level = paceLevel(pace);
  const text = paceText(pace);
  return (
    <div className={styles.pace}>
      <div role="meter" aria-label="Tape pace" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level} aria-valuetext={text} className={styles.meter}>
        <span className={styles.meterFill} style={{ width: `${level * 100}%` }} />
      </div>
      <p className={styles.paceText}>{text}</p>
    </div>
  );
}
