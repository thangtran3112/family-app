import { changeTone, formatEtClock, formatPrice } from "@/lib/desk/format";
import { formatUsd } from "@/lib/replay/journalView";
import styles from "./replay.module.css";

export type ReplayHeaderProps = {
  symbol: string;
  /** "Fri 2026-10-23", or "Hidden day". */
  dayLabel: string;
  attempt: number;
  playhead: string;
  lastPrice: number | null;
  /** Closed trades plus the open trade marked at the last price. */
  pnl: number;
};

/** Symbol, day, the playhead clock, last replayed price and Practice P/L (02o §a3). */
export function ReplayHeader({ symbol, dayLabel, attempt, playhead, lastPrice, pnl }: ReplayHeaderProps) {
  return (
    <div className={styles.header}>
      <div className={styles.identity}>
        <h1 className={styles.symbol}>{symbol}</h1>
        <span className={styles.chip}>{dayLabel}</span>
        {attempt > 1 && <span className={styles.chip}>Attempt {attempt}</span>}
        <span className={`${styles.chip} ${styles.practiceChip}`}>Practice</span>
      </div>
      <dl className={styles.readout}>
        <div><dt>Playhead</dt><dd className={styles.clock}>{formatEtClock(playhead)}</dd></div>
        <div><dt>Last price</dt><dd>{formatPrice(lastPrice)}</dd></div>
        <div><dt>Practice P/L</dt><dd data-tone={changeTone(pnl)}>{formatUsd(pnl)}</dd></div>
      </dl>
    </div>
  );
}
