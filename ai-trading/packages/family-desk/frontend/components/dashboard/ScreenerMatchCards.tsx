import type { Dashboard } from "@/lib/api/schemas";
import { matchCards } from "@/lib/desk/dashboardView";
import { emptyScanText } from "@/lib/desk/freshness";
import { symbolHref } from "@/lib/desk/listNav";
import styles from "./dashboard.module.css";

export function ScreenerMatchCards({ matches }: { matches: Dashboard["screener_matches"] }) {
  const cards = matchCards(matches);
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>Screener matches</h2>
      {cards.length === 0 && <p className={styles.muted}>No screener filters yet</p>}
      <ul className={styles.cards}>
        {cards.map((card) => (
          <li key={card.id} className={styles.card}>
            <a className={styles.cardTitle} href={`/screener?filter=${card.id}`}>{card.name}</a>
            <span>{card.count}</span>
            <span className={styles.muted}>{card.whenLabel}</span>
            {card.empty ? (
              <span className={styles.muted}>{emptyScanText(null)}</span>
            ) : (
              <span className={styles.top}>
                {card.top.map((symbol) => (
                  <a key={symbol} className={styles.link} href={symbolHref(symbol)}>{symbol}</a>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
