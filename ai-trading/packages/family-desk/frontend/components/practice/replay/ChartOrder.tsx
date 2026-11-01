"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { formatPrice } from "@/lib/desk/format";
import { chartOrderLabel } from "@/lib/replay/chartOrder";
import type { TicketSide } from "@/lib/replay/ticket";
import styles from "./replay.module.css";

export type ChartOrderProps = {
  symbol: string;
  /** The price she clicked, in whole cents. */
  price: number;
  /** The last print: it decides whether each side is a limit, a stop or a market order at this price. */
  last: number;
  /** The ticket's quantity: the chart order never has its own. */
  shares: string;
  /** Places the order through the ticket's own path. Resolves true when the server took it. */
  onPlace: (side: TicketSide, price: number) => Promise<boolean>;
  onClose: () => void;
};

/**
 * Click-to-order (owner directive 2026-11-01): what a click on the chart's price pane offers, the way a broker's chart does. Buy
 * and Sell at the clicked price, each named for the order it places ("Buy limit 184.00", "Sell stop 184.00"). The quantity is the
 * ticket's, and the order goes through the ticket's own path, so the cash rule and every refusal are the ticket's. Simulated.
 */
export function ChartOrder({ symbol, price, last, shares, onPlace, onClose }: ChartOrderProps) {
  const [busy, setBusy] = useState(false);
  const place = (side: TicketSide) => {
    if (busy) return;
    setBusy(true);
    void onPlace(side, price).then((accepted) => (accepted ? onClose() : setBusy(false)));
  };
  return (
    <div className={styles.chartOrder} role="group" aria-label="Chart order">
      <div className={styles.chartOrderHead}>
        <span className={styles.chartOrderPrice}>{`${symbol} ${formatPrice(price)}`}</span>
        <SimulatedBadge />
        <Button size="sm" variant="ghost" iconOnly aria-label="Close chart order" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </Button>
      </div>
      <Button variant="up" size="md" disabled={busy} onClick={() => place("buy")}>{chartOrderLabel("buy", price, last)}</Button>
      <Button variant="down" size="md" disabled={busy} onClick={() => place("sell")}>{chartOrderLabel("sell", price, last)}</Button>
      <p className={styles.summary}>{`Quantity ${shares.trim() || "—"} · set in the ticket`}</p>
    </div>
  );
}
