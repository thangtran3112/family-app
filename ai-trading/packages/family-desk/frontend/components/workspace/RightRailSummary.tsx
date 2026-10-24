import { OrdersOffNotice } from "@/components/shell/desktop/OrdersOffNotice";
import { BiasGauge } from "@/components/technicals/Gauges";
import type { Technicals } from "@/lib/api/schemas";
import { COPY } from "@/lib/desk/freshness";
import { verdictText } from "@/lib/desk/summary";
import { biasTone } from "@/lib/desk/workspace";
import styles from "./workspacePanels.module.css";

export function RightRailSummary({ technicals, timeframeLabel }: { technicals: Technicals; timeframeLabel: string }) {
  const summary = technicals.gauges.summary;
  return (
    <section className={styles.rail} aria-label="Recommendation">
      <BiasGauge size="compact" title="Summary" gauge={summary} quality={technicals.quality} asOf={technicals.as_of} />
      <p className={`${styles.verdict} ${styles[biasTone(summary.label)]}`}>{verdictText(summary.label, timeframeLabel)}</p>
      <p className={styles.footnote}>{COPY.advice}</p>
      <OrdersOffNotice />
    </section>
  );
}
