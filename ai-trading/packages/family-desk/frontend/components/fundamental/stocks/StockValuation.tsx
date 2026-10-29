import type { Valuation } from "@/lib/api/fundamentalSchemas";
import { blendView, filingText, impliedMoveText, methodRows, REACTION_NEEDS_REPORTS, reactionSummary } from "@/lib/desk/researchView";
import styles from "../fundamental.module.css";
import local from "./stocks.module.css";
import { ReactionChart } from "./ReactionChart";

/** FD9 Valuation & earnings (02n §b3): the four methods and their 60/40 blend against the price, the assumptions in words, and the last earnings reactions. The services' numbers, formatted only. */
export function StockValuation({ valuation }: { valuation: Valuation }) {
  const methods = methodRows(valuation.methods);
  const blend = blendView(valuation.blend, valuation.price);
  const reaction = valuation.earnings_reaction;
  return (
    <div className={local.stack} data-testid="fund-valuation">
      <section className={styles.panel} aria-label="Valuation methods">
        <h2 className={styles.panelTitle}>Fair value per share</h2>
        <p className={styles.muted}>{filingText(valuation.filing_as_of)}</p>
        <div>
          {methods.map((method) => (
            <div key={method.id} className={local.method} data-testid={`fund-method-${method.id}`}>
              <strong>{method.label}</strong>
              <span className={local.methodValue}>{method.value}</span>
              <ul className={local.methodNotes}>
                {method.inputs.map((line) => <li key={line}>{line}</li>)}
                {method.fallbacks.map((line) => <li key={line}>How this was estimated · {line}</li>)}
              </ul>
            </div>
          ))}
        </div>
        <div className={local.compare} aria-label="Blend against the price">
          <h3 className={local.subTitle}>Blend (60/40) against the price</h3>
          {blend === null ? (
            <p className={styles.muted}>{valuation.blend === null ? "Not enough data to blend the methods yet" : "No price to compare with yet"}</p>
          ) : (
            <>
              <div className={local.compareRow}><span>Blend</span><span className={local.compareBar} style={{ width: `${blend.blendPct}%` }} /><strong>{blend.blend}</strong></div>
              <div className={local.compareRow}><span>Price</span><span className={local.compareBar} data-kind="price" style={{ width: `${blend.pricePct}%` }} /><strong>{blend.price}</strong></div>
              <p className={styles.muted}>{blend.word}</p>
            </>
          )}
        </div>
      </section>

      <section className={styles.panel} aria-label="Earnings reaction" data-testid="fund-reaction">
        <h2 className={styles.panelTitle}>Earnings reaction</h2>
        {reaction === null ? (
          <p className={styles.muted}>{REACTION_NEEDS_REPORTS}</p>
        ) : (
          <>
            <ul className={styles.tiles}>
              {reactionSummary(reaction).map((tile) => (
                <li key={tile.label} className={styles.tile}>
                  <span className={styles.tileLabel}>{tile.label}</span>
                  <span className={styles.tileValue}>{tile.value}</span>
                </li>
              ))}
            </ul>
            <ReactionChart series={reaction.series} />
            <p className={styles.muted} data-testid="fund-implied-move">{impliedMoveText(reaction.implied_move_pct)}</p>
          </>
        )}
      </section>
    </div>
  );
}
