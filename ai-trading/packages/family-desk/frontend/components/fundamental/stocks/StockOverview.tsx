"use client";

import { useState } from "react";
import { MarketChart } from "@/components/charts/MarketChart";
import type { Research } from "@/lib/api/fundamentalSchemas";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadBars } from "@/lib/desk/charts";
import { COPY } from "@/lib/desk/freshness";
import { consensusPeriods, EPS_NOT_ENOUGH_HISTORY, NO_CONSENSUS, nextEarningsText, revisionCells, surpriseRows, targetsView } from "@/lib/desk/researchView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "../fundamental.module.css";
import local from "./stocks.module.css";
import { VerdictCard } from "./VerdictCard";

/** FD8 Stock overview (02n §b3): the Desk AI verdict, consensus EPS and revisions, analyst targets as context, and a price chart with no indicators. */
export function StockOverview({ symbol, research, price }: { symbol: string; research: Research; price: number | null }) {
  return (
    <div className={local.stack}>
      <VerdictCard verdict={research.verdict} price={price} />
      <div className={local.twoCols}>
        <Consensus consensus={research.consensus} />
        <div className={local.stack}>
          <Targets targets={research.targets} />
          <section className={styles.panel} aria-label="Alerts">
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Alerts</h2>
              {/* The alert templates are not started (02n §e): the button stays off and the reason is in words. */}
              <button type="button" className={styles.button} disabled aria-describedby="fund-alert-note">Alert me</button>
            </div>
            <p className={styles.muted} id="fund-alert-note">{COPY.alertTemplatesNotStarted}</p>
          </section>
        </div>
      </div>
      <PriceChart symbol={symbol} />
    </div>
  );
}

function Consensus({ consensus }: { consensus: Research["consensus"] }) {
  if (consensus === null) {
    return (
      <section className={styles.panel} aria-label="Consensus EPS" data-testid="fund-consensus">
        <h2 className={styles.panelTitle}>Consensus EPS</h2>
        <p className={styles.muted}>{NO_CONSENSUS}</p>
      </section>
    );
  }
  const quarters = consensusPeriods(consensus.quarters);
  const years = consensusPeriods(consensus.fiscal_years);
  const surprises = surpriseRows(consensus.surprises);
  return (
    <section className={styles.panel} aria-label="Consensus EPS" data-testid="fund-consensus">
      <h2 className={styles.panelTitle}>Consensus EPS</h2>
      <p className={styles.muted}>Next earnings · {nextEarningsText(consensus.next_earnings)}</p>
      <ul className={local.revisions} aria-label="Estimate revisions">
        {revisionCells(consensus.revisions).map((cell) => (
          <li key={cell.label} className={styles.tile}>
            <span className={styles.tileLabel}>Revised {cell.label}</span>
            <span className={`${styles.tileValue} ${cell.text === EPS_NOT_ENOUGH_HISTORY ? local.quiet : ""}`}>
              <span className={styles.tone} data-tone={cell.tone}>{cell.text}</span>
            </span>
          </li>
        ))}
      </ul>
      <PeriodTable caption="Quarterly estimates" rows={quarters} />
      <PeriodTable caption="Fiscal-year estimates" rows={years} />
      {surprises.length > 0 && (
        <table className={local.table} aria-label="Earnings surprises">
          <thead><tr><th scope="col">Quarter</th><th scope="col">Actual</th><th scope="col">Estimate</th><th scope="col">Surprise</th><th scope="col">Result</th></tr></thead>
          <tbody>
            {surprises.map((row) => (
              <tr key={row.period}>
                <th scope="row">{row.period}</th>
                <td>{row.actual}</td>
                <td>{row.estimate}</td>
                <td><span className={styles.tone} data-tone={row.tone}>{row.surprise}</span></td>
                <td>{row.word}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PeriodTable({ caption, rows }: { caption: string; rows: ReturnType<typeof consensusPeriods> }) {
  if (rows.length === 0) return null;
  return (
    <table className={local.table} aria-label={caption}>
      <thead><tr><th scope="col">{caption.startsWith("Quarterly") ? "Quarter" : "Fiscal year"}</th><th scope="col">EPS estimate</th><th scope="col">Analysts</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.period}><th scope="row">{row.period}</th><td>{row.eps}</td><td>{row.analysts}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/** Analyst targets are context from outside the Desk; they are never shown as the Desk AI's own target. */
function Targets({ targets }: { targets: Research["targets"] }) {
  const view = targets === null ? null : targetsView(targets);
  return (
    <section className={styles.panel} aria-label="Analyst targets" data-testid="fund-targets">
      <h2 className={styles.panelTitle}>Analyst targets</h2>
      {view === null ? (
        <p className={styles.muted}>No analyst targets for this symbol yet</p>
      ) : (
        <dl className={local.kvList}>
          <div className={local.kv}><dt>Low</dt><dd>{view.low}</dd></div>
          <div className={local.kv}><dt>Mean</dt><dd>{view.mean}</dd></div>
          <div className={local.kv}><dt>High</dt><dd>{view.high}</dd></div>
          <div className={local.kv}><dt>Ratings</dt><dd>{view.counts}</dd></div>
        </dl>
      )}
    </section>
  );
}

type Interval = "1d" | "1w";
// Calendar days of bars to ask for: a year of daily bars, five of weekly (the same spans the Technicals chart uses).
const DAYS: Record<Interval, number> = { "1d": 365, "1w": 1825 };

/** A price chart with no indicators and no overlays (02n §f): `MarketChart` with only the bars. */
function PriceChart({ symbol }: { symbol: string }) {
  const [interval, setInterval] = useState<Interval>("1d");
  const bars = useDeskQuery(`bars:${symbol}:${interval}`, (signal) => loadBars(symbol, interval, { days: DAYS[interval] }, { signal }));
  return (
    <section className={styles.panel} aria-label="Price chart" data-testid="fund-chart">
      <div className={local.chartHead}>
        <h2 className={styles.panelTitle}>Price</h2>
        <div className={local.toggle} role="group" aria-label="Chart range">
          {(["1d", "1w"] as const).map((value) => (
            <button key={value} type="button" className={local.toggleButton} aria-pressed={interval === value} onClick={() => setInterval(value)}>{value === "1d" ? "1D" : "1W"}</button>
          ))}
        </div>
      </div>
      {bars.data ? (
        bars.data.bars.length > 0 ? (
          <MarketChart symbol={symbol} interval={interval} bars={bars.data.bars} quality={bars.data.quality} asOf={bars.data.as_of} height={260} />
        ) : (
          <EmptyBlock title="No price history for this symbol yet" />
        )
      ) : bars.error !== null ? (
        <ErrorBlock subject="chart" onRetry={bars.refresh} />
      ) : (
        <LoadingBlock label="Loading chart…" height={260} />
      )}
    </section>
  );
}
