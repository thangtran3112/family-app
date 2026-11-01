import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import play from "@/components/practice/swing/play.module.css";
import { changeTone, formatEtClock, formatPrice } from "@/lib/desk/format";
import type { Speed } from "@/lib/replay/clock";
import { formatSignedUsd } from "@/lib/desk/mask";
import { playerPillText, type PlayerStatus } from "@/lib/replay/player";
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
  /** Session VWAP at the playhead, from the chart's own series; null before there is one. */
  vwap: number | null;
  /** The prior session's close; null when the feed has none. */
  priorClose: number | null;
  /** Closed trades plus the open trade marked at the last price. */
  pnl: number;
  status: PlayerStatus;
  speed: Speed;
  /** Swing session only. */
  swing?: SwingHeaderBar;
};

/** Symbol, day, the playhead clock, last replayed price, VWAP, prior close and Practice P/L (02o §a3). The P/L is simulated: realized trades plus the open trade at the last price. A swing session adds its money bar. */
export function ReplayHeader({ symbol, dayLabel, attempt, playhead, lastPrice, vwap, priorClose, pnl, status, speed, swing }: ReplayHeaderProps) {
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
          <div><dt>VWAP</dt><dd>{formatPrice(vwap)}</dd></div>
          <div><dt>Prior close</dt><dd>{formatPrice(priorClose)}</dd></div>
          <div title="Closed practice trades plus the open trade at the last price">
            <dt>Practice P/L</dt>
            <dd className={styles.pnl} data-tone={changeTone(pnl)}>
              <span>{formatSignedUsd(pnl, { cents: true })}</span>
              <SimulatedBadge />
            </dd>
          </div>
        </dl>
        <span className={styles.statePill} data-state={status}>{playerPillText(status, speed)}</span>
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
