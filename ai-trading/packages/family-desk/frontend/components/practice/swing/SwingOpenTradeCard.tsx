import { changeTone, formatPrice } from "@/lib/desk/format";
import { formatSignedUsd } from "@/lib/desk/mask";
import { formatR } from "@/lib/replay/journalView";
import { SWING_PLAY_COPY } from "@/lib/replay/playView";
import type { OpenTrade } from "@/lib/replay/schemas";
import { daysHeldText, gapText, holdEntryLabel, priceBasisLabel, sideLabel } from "@/lib/replay/swing";
import { dayResultTone } from "@/lib/replay/threadView";
import styles from "./play.module.css";

/**
 * The name's practice hold at the day clock (02p b3, a4): side and shares, the day and price she entered, days held, the
 * overnight gap of a carried hold, the stop, the price it is valued at ("Prior close 187.40" before the open, "Last 182.10"
 * after) and its unrealized P/L and R. Replaces the day workspace's open-trade card.
 */
export function SwingOpenTradeCard({ trade, tape }: { trade: OpenTrade | null; tape: "on" | "off" }) {
  if (!trade) return <p className={styles.muted}>{SWING_PLAY_COPY.noOpenHold}</p>;
  const gap = gapText(trade.gap_usd);
  return (
    <dl className={styles.card} aria-label={SWING_PLAY_COPY.holdOpenCardLabel}>
      <div><dt>Side</dt><dd>{sideLabel(trade.side)} {trade.shares}</dd></div>
      <div>
        <dt>Entry</dt>
        <dd>{trade.opened_day_no == null ? formatPrice(trade.entry_price) : holdEntryLabel({ entry_day_no: trade.opened_day_no, entry_price: trade.entry_price })}</dd>
      </div>
      {trade.days_held != null && <div><dt className={styles.srOnly}>Held</dt><dd>{daysHeldText(trade.days_held)}</dd></div>}
      {gap !== null && <div><dt className={styles.srOnly}>Overnight move</dt><dd data-tone={dayResultTone(trade.gap_usd)}>{gap}</dd></div>}
      <div><dt>Stop</dt><dd>{trade.stop_price == null ? "none" : formatPrice(trade.stop_price)}</dd></div>
      <div><dt>Price</dt><dd>{priceBasisLabel(trade.price_basis, trade.last_price, tape)}</dd></div>
      <div><dt>Unrealized</dt><dd data-tone={changeTone(trade.unrealized_usd)}>{formatSignedUsd(trade.unrealized_usd, { cents: true })}</dd></div>
      {trade.r != null && <div><dt>R</dt><dd data-tone={changeTone(trade.r)}>{formatR(trade.r)}</dd></div>}
    </dl>
  );
}
