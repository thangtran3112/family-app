import { FactList, type Fact } from "@/components/ui/FactList";
import { formatPrice, signTone } from "@/lib/desk/format";
import { formatSignedUsd } from "@/lib/desk/mask";
import { formatR } from "@/lib/replay/journalView";
import { SWING_PLAY_COPY } from "@/lib/replay/playView";
import type { OpenTrade } from "@/lib/replay/schemas";
import { daysHeldText, gapText, holdEntryLabel, priceBasisLabel, sideLabel } from "@/lib/replay/swing";
import styles from "./play.module.css";

/**
 * The name's practice hold at the day clock (02p b3, a4): side and shares, the day and price she entered, days held, the
 * overnight gap of a carried hold, the stop, the price it is valued at ("Prior close 187.40" before the open, "Last 182.10"
 * after) and its unrealized P/L and R. Replaces the day workspace's open-trade card.
 */
export function SwingOpenTradeCard({ trade, tape }: { trade: OpenTrade | null; tape: "on" | "off" }) {
  if (!trade) return <p className={styles.muted}>{SWING_PLAY_COPY.noOpenHold}</p>;
  const gap = gapText(trade.gap_usd);
  const facts: Fact[] = [
    { id: "side", label: "Side", value: `${sideLabel(trade.side)} ${trade.shares}` },
    { id: "entry", label: "Entry", value: trade.opened_day_no == null ? formatPrice(trade.entry_price) : holdEntryLabel({ entry_day_no: trade.opened_day_no, entry_price: trade.entry_price }) },
    ...(trade.days_held != null ? [{ id: "held", label: "Held", value: daysHeldText(trade.days_held) }] : []),
    ...(gap !== null ? [{ id: "gap", label: "Overnight move", value: gap, tone: signTone(trade.gap_usd) }] : []),
    { id: "stop", label: "Stop", value: trade.stop_price == null ? "None" : formatPrice(trade.stop_price) },
    { id: "price", label: "Price", value: priceBasisLabel(trade.price_basis, trade.last_price, tape) },
    { id: "unrealized", label: "Unrealized", value: formatSignedUsd(trade.unrealized_usd, { cents: true }), tone: signTone(trade.unrealized_usd) },
    ...(trade.r != null ? [{ id: "r", label: "R", value: formatR(trade.r), tone: signTone(trade.r) }] : []),
  ];
  return <FactList label={SWING_PLAY_COPY.holdOpenCardLabel} columns={2} facts={facts} />;
}
