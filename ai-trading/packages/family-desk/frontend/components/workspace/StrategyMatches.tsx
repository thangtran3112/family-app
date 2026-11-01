import { RailList, RailValue } from "@/components/ui/RailList";
import type { Technicals } from "@/lib/api/schemas";
import { countsLine, STRATEGY_GAUGE_EMPTY } from "@/lib/desk/summary";
import { biasUiTone } from "@/lib/desk/workspace";
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
          <RailList
            divided
            rows={gauge.votes.map((vote) => {
              const word = VOTE_WORD[vote.vote];
              return {
                id: String(vote.strategy_id),
                label: vote.name,
                value: (
                  <>
                    <strong><RailValue tone={biasUiTone(word)}>{word}</RailValue></strong>
                    <RailValue>{BIAS_WORD[vote.bias]}</RailValue>
                  </>
                ),
              };
            })}
          />
          {gauge.watching.length > 0 && (
            <>
              <h4 className={styles.heading}>Watching</h4>
              <RailList divided rows={gauge.watching.map((item) => ({ id: String(item.strategy_id), label: <RailValue>{item.name}</RailValue>, title: item.name }))} />
            </>
          )}
        </>
      )}
    </section>
  );
}
