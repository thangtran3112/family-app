import type { Technicals } from "@/lib/api/schemas";
import { countsLine, STRATEGY_GAUGE_EMPTY } from "@/lib/desk/summary";
import { biasTone } from "@/lib/desk/workspace";
import styles from "./workspacePanels.module.css";

const VOTE_WORD = { buy: "Buy", neutral: "Neutral", sell: "Sell" } as const;
const BIAS_WORD = { bullish: "bullish", bearish: "bearish", neutral: "neutral" } as const;

export function StrategyMatches({ gauge }: { gauge: Technicals["gauges"]["strategies"] }) {
  return (
    <section className={styles.section} aria-label="Strategy matches">
      <h3 className={styles.heading}>Strategy matches</h3>
      {gauge === null ? (
        <p className={styles.muted}>{STRATEGY_GAUGE_EMPTY}</p>
      ) : (
        <>
          <p className={styles.muted}>{countsLine(gauge.counts)}</p>
          <ul className={styles.list}>
            {gauge.votes.map((vote) => {
              const word = VOTE_WORD[vote.vote];
              return (
                <li key={vote.strategy_id} className={styles.listRow}>
                  <span className={styles.ellipsis} title={vote.name}>{vote.name}</span>
                  <span className={styles.ends}>
                    <strong className={styles[biasTone(word)]}>{word}</strong>
                    <span className={styles.muted}>{BIAS_WORD[vote.bias]}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          {gauge.watching.length > 0 && (
            <>
              <h4 className={styles.heading}>Watching</h4>
              <ul className={styles.list}>
                {gauge.watching.map((item) => (
                  <li key={item.strategy_id} className={styles.listRow}>
                    <span className={`${styles.muted} ${styles.ellipsis}`} title={item.name}>{item.name}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
