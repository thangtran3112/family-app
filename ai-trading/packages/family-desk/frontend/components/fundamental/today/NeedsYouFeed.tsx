import Link from "next/link";
import { LoadingBlock } from "@/components/ui/StateBlocks";
import type { FeedItem, FeedKind } from "@/lib/desk/fundamentalToday";
import styles from "../fundamental.module.css";
import local from "./today.module.css";

const KIND_LABEL: Record<FeedKind, string> = { short_call_risk: "Call risk", earnings_soon: "Earnings", ex_dividend: "Ex-dividend", import: "Holdings" };

/** The "Needs you" feed (FD2): what the holdings and open calls ask of the owner today, built in lib/desk/fundamentalToday.ts. */
export function NeedsYouFeed({ items, loading = false, dim = false }: { items: readonly FeedItem[]; loading?: boolean; dim?: boolean }) {
  return (
    <section className={`${styles.panel} ${dim ? styles.dim : ""}`} aria-labelledby="fund-feed-title">
      <h2 id="fund-feed-title" className={styles.panelTitle}>Needs you</h2>
      {loading ? (
        <LoadingBlock label="Loading what needs you…" height={96} />
      ) : items.length === 0 ? (
        <p className={styles.muted} data-testid="fund-feed-empty">Nothing needs you right now</p>
      ) : (
        <ul className={styles.list} data-testid="fund-feed">
          {items.map((item, index) => (
            <li key={`${item.kind}-${item.symbol ?? "all"}-${index}`}>
              <Link className={local.item} href={item.href} data-testid="fund-feed-item">
                <span className={local.kind} data-kind={item.kind}>{KIND_LABEL[item.kind]}</span>
                <span className={local.itemBody}>
                  <span className={local.itemTitle}>{item.title}</span>
                  <span className={local.itemDetail}>{item.detail}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
