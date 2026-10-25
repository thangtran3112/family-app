import type { PaceView } from "@/lib/replay/feedState";
import { paceHeading, paceLevel, paceRate, paceText, paceVerdict } from "@/lib/replay/tape";
import styles from "./panels.module.css";

/** The pace over its window ("Pace · 10 seconds", "Quiet · 1.4x usual"), a thin meter (0 to 1) and the rate under it. */
export function TapePace({ pace }: { pace: PaceView | null }) {
  const level = paceLevel(pace);
  return (
    <div className={styles.pace}>
      <div className={styles.paceHead}>
        <span className={styles.heading}>{paceHeading(pace)}</span>
        {pace && <span className={styles.paceVerdict}>{paceVerdict(pace)}</span>}
      </div>
      <div role="meter" aria-label="Tape pace" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level} aria-valuetext={paceText(pace)} className={styles.meter}>
        <span className={styles.meterFill} style={{ width: `${level * 100}%` }} />
      </div>
      <p className={styles.paceText}>{pace ? paceRate(pace) : paceText(pace)}</p>
    </div>
  );
}
