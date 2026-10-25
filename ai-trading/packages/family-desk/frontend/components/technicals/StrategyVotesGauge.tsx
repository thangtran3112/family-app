import type { Technicals } from "@/lib/api/schemas";
import { STRATEGY_GAUGE_EMPTY } from "@/lib/desk/summary";
import { qualityPhrase } from "@/lib/desk/freshness";
import { BiasGauge } from "./Gauges";
import styles from "./summary.module.css";

const VOTE_WORD = { buy: "Buy", neutral: "Neutral", sell: "Sell" } as const;
const VOTE_TONE = { buy: "up", neutral: "flat", sell: "down" } as const;
const BIAS_WORD = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" } as const;

export function StrategyVotesGauge({
  gauge,
  quality,
  asOf,
}: {
  gauge: Technicals["gauges"]["strategies"];
  quality: Technicals["quality"];
  asOf: string | null;
}) {
  if (!gauge) {
    return (
      <section className={styles.card} aria-label="Her strategies gauge">
        <header className={styles.header}>
          <h2>Her strategies</h2>
          <span className={styles.meta}>{qualityPhrase(quality)}</span>
        </header>
        <p className={styles.empty}>{STRATEGY_GAUGE_EMPTY}</p>
      </section>
    );
  }

  return (
    <div className={styles.votes}>
      <BiasGauge size="large" title="Her strategies" gauge={{ label: gauge.label, score: gauge.score, counts: gauge.counts }} quality={quality} asOf={asOf} />
      {gauge.votes.length > 0 && (
        <ul className={styles.list} aria-label="Strategy votes">
          {gauge.votes.map((vote) => (
            <li key={vote.strategy_id} className={styles.row}>
              <span>{vote.name}</span>
              <span className={styles[VOTE_TONE[vote.vote]]}>{VOTE_WORD[vote.vote]}</span>
              <span className={styles.muted}>{BIAS_WORD[vote.bias]}</span>
            </li>
          ))}
        </ul>
      )}
      {gauge.watching.length > 0 && (
        <section className={styles.watching}>
          <h3 className={styles.caps}>Watching</h3>
          <ul className={styles.list}>
            {gauge.watching.map((item) => (
              <li key={item.strategy_id} className={styles.muted}>{item.name}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
