import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import type { Stamp } from "@/lib/api/schemas";
import { resolveFreshness, type Connection, type MarketSession } from "@/lib/desk/freshness";
import { changeTone, formatPrice } from "@/lib/desk/format";
import { changeText, type PriceSummary } from "@/lib/desk/workspace";
import styles from "./workspaceHeader.module.css";

export type SymbolHeaderProps = {
  symbol: string;
  name: string | null;
  summary: PriceSummary;
  stamp: Stamp | null;
  session?: MarketSession;
  connection: Connection;
  view: "chart" | "summary";
};

/** Symbol, last price and change, freshness, and the Chart · Summary tabs (02l §b2). */
export function SymbolHeader({ symbol, name, summary, stamp, session, connection, view }: SymbolHeaderProps) {
  const dim = resolveFreshness({ stamp, session, connection }).dim;
  return (
    <div className={styles.header}>
      <div className={styles.identity}>
        <h1 className={styles.symbol}>{symbol}</h1>
        {name && <span className={styles.name}>{name}</span>}
        <div className={styles.quote} data-dim={dim ? "true" : undefined}>
          <span className={styles.price}>{formatPrice(summary.last)}</span>
          <span className={styles.change} data-tone={changeTone(summary.change)}>{changeText(summary)}</span>
        </div>
        <FreshnessBadge stamp={stamp} session={session} connection={connection} />
      </div>
      <nav aria-label="Chart or summary" className={styles.tabs}>
        <a href="#chart" className={styles.tab} aria-current={view === "chart" ? "page" : undefined}>Chart</a>
        <a href="#summary" className={styles.tab} aria-current={view === "summary" ? "page" : undefined}>Summary</a>
      </nav>
    </div>
  );
}
