import { OrdersOffNotice } from "@/components/shell/desktop/OrdersOffNotice";
import { COPY } from "@/lib/desk/freshness";
import styles from "./summary.module.css";

export function SummaryFootnote() {
  return (
    <footer className={styles.footnote}>
      <p className={styles.advice}>{COPY.advice}</p>
      <OrdersOffNotice />
      <details className={styles.method}>
        <summary>How Desk Technical Bias is computed</summary>
        <p>Each voting indicator follows the Desk&apos;s published TradingView-based rule. Oscillator votes and moving-average votes are averaged separately; the summary is their mean. Values without enough history remain unavailable and do not vote. Closed bars only. Not a recommendation.</p>
      </details>
    </footer>
  );
}
