import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { Badge } from "@/components/ui/Badge";
import { changeToneAt, formatPrice } from "@/lib/desk/format";
import { formatSignedUsd } from "@/lib/desk/mask";
import styles from "./replay.module.css";

export type ReplayHeaderProps = {
  symbol: string;
  /** The ET calendar date of the thread's time, "Fri 2026-10-23": a label that follows T across days and ends, resets and reviews nothing. */
  dateLabel: string;
  lastPrice: number | null;
  /** Session VWAP at the thread's time, from the chart's own series; null before there is one. */
  vwap: number | null;
  /** The prior session's close; null when the feed has none. */
  priorClose: number | null;
  /** Closed trades plus the open trade marked at the last price. */
  pnl: number;
};

/** One name: its symbol, the date of the thread's time, last replayed price, VWAP, prior close and Practice P/L (02o §a3). The P/L is simulated: realized trades plus the open trade at the last price. It carries no clock and no player state: the time is the thread's. */
export function ReplayHeader({ symbol, dateLabel, lastPrice, vwap, priorClose, pnl }: ReplayHeaderProps) {
  return (
    <div className={styles.header}>
      <div className={styles.identity}>
        <h1 className={styles.symbol}>{symbol}</h1>
        <Badge tone="neutral">{dateLabel}</Badge>
        <Badge tone="warn">Practice</Badge>
      </div>
      <dl className={styles.readout}>
        <div><dt>Last price</dt><dd>{formatPrice(lastPrice)}</dd></div>
        <div><dt>VWAP</dt><dd>{formatPrice(vwap)}</dd></div>
        <div><dt>Prior close</dt><dd>{formatPrice(priorClose)}</dd></div>
        <div title="Closed practice trades plus the open trade at the last price">
          <dt>Practice P/L</dt>
          <dd className={styles.pnl} data-tone={changeToneAt(pnl, 2)}>
            <span>{formatSignedUsd(pnl, { cents: true })}</span>
            <SimulatedBadge />
          </dd>
        </div>
      </dl>
    </div>
  );
}
