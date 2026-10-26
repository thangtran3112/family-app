import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import play from "@/components/practice/swing/play.module.css";
import { changeTone, formatEtClock, formatPrice } from "@/lib/desk/format";
import { formatUsd } from "@/lib/replay/journalView";
import styles from "./replay.module.css";

/** The swing thread's money line under the symbol row (02p h): balance, equity and free cash, and the tape note. No journal link (a swing session is scored weekly). */
export type SwingHeaderBar = {
  /** "Balance $51,240 · Equity $52,010 · Free cash $24,720" (the SIMULATED badge follows it). */
  money: string;
  /** "Tape off · swing prices are one-minute closes", or null with the tape on. */
  tapeNote: string | null;
};

export type ReplayHeaderProps = {
  symbol: string;
  /** "Fri 2026-10-23", "Hidden day", or for a swing day "Day 7 of 20 · Week 2 · Tue". */
  dayLabel: string;
  attempt: number;
  playhead: string;
  lastPrice: number | null;
  /** Closed trades plus the open trade marked at the last price. */
  pnl: number;
  /** Swing session only. */
  swing?: SwingHeaderBar;
};

/** Symbol, day, the playhead clock, last replayed price and Practice P/L (02o §a3). A swing session adds its money bar. */
export function ReplayHeader({ symbol, dayLabel, attempt, playhead, lastPrice, pnl, swing }: ReplayHeaderProps) {
  return (
    <>
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
      {swing && (
        <div className={play.bar} role="group" aria-label="Practice thread">
          <span className={play.barMain}>
            <span>{swing.money}</span>
            <SimulatedBadge />
          </span>
          <span className={play.barSide}>
            {swing.tapeNote && <span className={play.tapeNote}>{swing.tapeNote}</span>}
          </span>
        </div>
      )}
    </>
  );
}
