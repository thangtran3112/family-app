import type { Research } from "@/lib/api/fundamentalSchemas";
import { AiRatingChip } from "@/components/fundamental/shared/AiRatingChip";
import { Banner } from "@/components/ui/Banner";
import { PanelHeader } from "@/components/ui/Panel";
import { DeskAiNotStarted } from "@/components/fundamental/shared/DeskAiNotStarted";
import { formatEtDay } from "@/lib/desk/format";
import { formatUsdPrice } from "@/lib/desk/mask";
import { confidenceText, targetBar, verdictStale, voteLine } from "@/lib/desk/researchView";
import styles from "../fundamental.module.css";
import local from "./stocks.module.css";

/** The Desk AI verdict (violet). Until the first daily run there is no verdict, and the card says so instead of showing a stand-in. */
export function VerdictCard({ verdict, price }: { verdict: Research["verdict"]; price: number | null }) {
  if (verdict === null) {
    return (
      <div data-testid="fund-verdict-card">
        <DeskAiNotStarted title="Desk AI verdict" />
      </div>
    );
  }
  const bar = targetBar(verdict.target, price);
  const stale = verdictStale(verdict.stale_days, verdict.as_of);
  return (
    <section className={styles.aiPanel} aria-label="Desk AI verdict" data-testid="fund-verdict-card">
      <h2 className={styles.aiTitle}>Desk AI verdict</h2>
      <div className={local.verdictHead}>
        <AiRatingChip rating={verdict.rating} />
        <span className={local.verdictTarget}>Base target {formatUsdPrice(verdict.target.base)}</span>
        <span className={styles.caption}>{confidenceText(verdict.confidence)}</span>
        <span className={styles.caption}>As of {formatEtDay(verdict.as_of)}</span>
      </div>
      {stale && <Banner>{stale}</Banner>}
      <div className={local.range} role="img" aria-label={`Target range ${formatUsdPrice(verdict.target.low)} to ${formatUsdPrice(verdict.target.high)}${price === null ? "" : `, price ${formatUsdPrice(price)}`}`}>
        <span className={local.rangeTrack} />
        <span className={local.rangeSpan} style={{ left: `${bar.low}%`, width: `${bar.high - bar.low}%` }} />
        <span className={local.rangeBase} style={{ left: `${bar.base}%` }} />
        {bar.price !== null && <span className={local.rangePrice} style={{ left: `${bar.price}%` }} />}
      </div>
      <ul className={local.rangeLegend}>
        <li>Low {formatUsdPrice(verdict.target.low)}</li>
        <li>Base {formatUsdPrice(verdict.target.base)}</li>
        <li>High {formatUsdPrice(verdict.target.high)}</li>
        {price !== null && <li>Price {formatUsdPrice(price)}</li>}
      </ul>
      <PanelHeader variant="label" level={3} title="What changed" />
      <p className={styles.muted}>{verdict.changed}</p>
      <div className={local.twoCols}>
        <div>
          <PanelHeader variant="label" level={3} title="Reasons" />
          <ul className={local.bullets}>{verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </div>
        <div>
          <PanelHeader variant="label" level={3} title="Risks" />
          <ul className={local.bullets}>{verdict.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
        </div>
      </div>
      <details className={local.how}>
        <summary>How Desk AI decided</summary>
        <div>
          <PanelHeader variant="label" level={3} title="Votes" />
          <ul className={local.bullets}>
            {verdict.votes.map((vote) => (
              <li key={vote.name}>
                {voteLine(vote)}
                {vote.reasons.length > 0 && <span className={styles.caption}> · {vote.reasons.join("; ")}</span>}
              </li>
            ))}
          </ul>
          <p><strong>Bull case.</strong> {verdict.bull}</p>
          <p><strong>Bear case.</strong> {verdict.bear}</p>
          <PanelHeader variant="label" level={3} title="Inputs" />
          <ul className={local.bullets}>{verdict.inputs.map((input) => <li key={input.name}>{input.name} · as of {formatEtDay(input.as_of)}</li>)}</ul>
        </div>
      </details>
    </section>
  );
}
