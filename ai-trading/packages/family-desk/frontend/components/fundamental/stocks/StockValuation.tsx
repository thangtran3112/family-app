import { Panel, PanelHeader } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";
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
      <Panel aria-label="Valuation methods">
        <PanelHeader title="Fair value per share" />
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
          <PanelHeader variant="label" level={3} title="Blend (60/40) against the price" />
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
      </Panel>

      <div data-testid="fund-reaction">
        <Panel aria-label="Earnings reaction">
          <PanelHeader title="Earnings reaction" />
          {reaction === null ? (
            <p className={styles.muted}>{REACTION_NEEDS_REPORTS}</p>
          ) : (
            <>
              <ul className={styles.tiles}>
                {reactionSummary(reaction).map((tile) => (
                  <li key={tile.label}>
                    <StatTile label={tile.label} value={tile.value} />
                  </li>
                ))}
              </ul>
              <ReactionChart series={reaction.series} />
              <p className={styles.muted} data-testid="fund-implied-move">{impliedMoveText(reaction.implied_move_pct)}</p>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
