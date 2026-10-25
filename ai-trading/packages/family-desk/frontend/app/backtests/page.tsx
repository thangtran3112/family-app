import type { Metadata } from "next";
import { FixtureScreen } from "../../components/FixtureScreen.tsx";
import styles from "../../components/fixtures.module.css";
import { divergingBars, lineCoordinates } from "../../lib/fixtures/chart-geometry.ts";
import {
  backtestDrawdown,
  backtestEquityCurve,
  backtestLimitations,
  backtestMetrics,
  backtestSettings,
  backtestTrades,
  backtestYearlyReturns,
} from "../../lib/fixtures/backtests.ts";

export const metadata: Metadata = { title: "Backtests" };

export default function BacktestsPage() {
  const strategyValues = backtestEquityCurve.points.map((point) => point.strategy);
  const benchmarkValues = backtestEquityCurve.points.map((point) => point.benchmark);
  const equityDomain = {
    minimum: Math.min(...strategyValues, ...benchmarkValues),
    maximum: Math.max(...strategyValues, ...benchmarkValues),
  };
  const strategyLine = lineCoordinates(strategyValues, 100, 54, equityDomain);
  const benchmarkLine = lineCoordinates(benchmarkValues, 100, 54, equityDomain);
  const drawdownLine = lineCoordinates(backtestDrawdown.map((point) => point.value), 100, 44);
  const yearlyBars = divergingBars(backtestYearlyReturns);

  return (
    <FixtureScreen title="Backtest">
      <div className={styles.content}>
        <section className={styles.section} aria-label="Backtest fixture details">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>ILLUSTRATIVE RUN · NO COMPUTATION PERFORMED</p>
              <p className={styles.bodyText}>Pullback to the 20-day average · v3 · sample run record</p>
            </div>
            <span className={styles.fixtureTag}>SAMPLE ONLY</span>
          </div>
          <div className={styles.panel}>
            <div className={styles.panelHeading}>
              <h2>Run assumptions</h2>
              <span className={styles.fixtureTag}>DEMO CONFIGURATION</span>
            </div>
            <dl className={styles.definitionGrid}>
              {backtestSettings.map((setting) => <div key={setting.label}><dt>{setting.label}</dt><dd>{setting.value}</dd></div>)}
            </dl>
          </div>
          <button className={styles.button} type="button" disabled aria-label="Run backtest, not available yet">Run backtest · not available yet</button>
          <p className={styles.footnote}>Backtesting is not wired yet. Every result below is synthetic fixture data, not a run of this strategy.</p>
        </section>

        <section className={styles.section} aria-labelledby="backtest-summary-title">
          <div className={styles.panelHeading}>
            <h2 id="backtest-summary-title">Example risk &amp; return metrics</h2>
            <span className={styles.fixtureTag}>NOT A STRATEGY RESULT</span>
          </div>
          <div className={styles.cards4}>
            {backtestMetrics.map((metric) => (
              <article className={styles.panel} key={metric.label}>
                <span className={styles.statLabel}>{metric.label}</span>
                <strong className={styles.statValue}>{metric.value}</strong>
                <span className={styles.statDetail}>Illustrative only</span>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="equity-title">
          <div className={styles.panelHeading}>
            <div><h2 id="equity-title">Equity curve vs. SPY buy &amp; hold</h2><p className={styles.muted}>{backtestEquityCurve.label}</p></div>
            <span className={styles.fixtureTag}>SYNTHETIC CHART</span>
          </div>
          <div className={`${styles.panel} ${styles.panelStack}`}>
            <div className={styles.spread}><span className={styles.positive}>Strategy · {backtestEquityCurve.strategyTotalReturn}</span><span>SPY buy &amp; hold · {backtestEquityCurve.benchmarkTotalReturn}</span></div>
            <svg className={styles.lineChart} viewBox="0 0 100 60" role="img" aria-label="Synthetic strategy and benchmark equity curves, normalized to 100 at start">
              <line x1="0" x2="100" y1="54" y2="54" className={styles.lineChartGrid} />
              <line x1="0" x2="100" y1="27" y2="27" className={styles.lineChartGrid} />
              <polyline points={benchmarkLine.map((point) => `${point.x},${point.y}`).join(" ")} className={styles.lineChartBenchmark} />
              <polyline points={strategyLine.map((point) => `${point.x},${point.y}`).join(" ")} className={styles.lineChartStrategy} />
            </svg>
            <ul className={styles.chartDataList}>
              {backtestEquityCurve.points.map((point) => <li key={point.year}>{point.year}: strategy {point.strategy.toFixed(1)} · sample SPY {point.benchmark.toFixed(1)}</li>)}
            </ul>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="drawdown-title">
          <div className={styles.panelHeading}><div><h2 id="drawdown-title">Drawdown</h2><p className={styles.muted}>Synthetic peak-to-trough path</p></div><span className={styles.fixtureTag}>SAMPLE SERIES</span></div>
          <div className={`${styles.panel} ${styles.panelStack}`}>
            <svg className={styles.lineChart} viewBox="0 0 100 50" role="img" aria-label="Synthetic drawdown series, descending from zero to a maximum of minus 11.8 percent">
              <line x1="0" x2="100" y1="0" y2="0" className={styles.lineChartGrid} />
              <polyline points={drawdownLine.map((point) => `${point.x},${point.y}`).join(" ")} className={styles.lineChartDrawdown} />
            </svg>
            <ul className={styles.chartDataList}>
              {backtestDrawdown.map((point) => <li key={point.year}>{point.year}: {point.value > 0 ? "+" : ""}{point.value.toFixed(1)}% drawdown</li>)}
            </ul>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="yearly-title">
          <div className={styles.panelHeading}><div><h2 id="yearly-title">Return by year</h2><p className={styles.muted}>Each bar encodes numeric fixture return from a zero baseline.</p></div><span className={styles.fixtureTag}>ANNUAL RETURNS</span></div>
          <div className={`${styles.panel} ${styles.panelStack}`}>
            <div className={`${styles.zeroChart} ${styles.yearlyChart}`} role="img" aria-label="Synthetic annual returns with gains above zero and 2022 loss below zero">
              {yearlyBars.map((bar) => (
                <div className={styles.zeroChartColumn} key={bar.label}>
                  <span className={styles.zeroChartValue}>{bar.value > 0 ? "+" : ""}{bar.value.toFixed(1)}%</span>
                  <span className={styles.zeroChartPlot}>
                    <span className={styles.zeroBaseline} style={{ top: `${bar.baselinePercent}%` }} />
                    <span className={`${styles.zeroBar} ${bar.value < 0 ? styles.negativeBar : ""}`} style={{ top: `${bar.topPercent}%`, height: `${bar.heightPercent}%` }} />
                  </span>
                  <span className={styles.zeroChartLabel}>{bar.label}</span>
                </div>
              ))}
            </div>
            <ul className={styles.chartDataList}>{backtestYearlyReturns.map((item) => <li key={item.label}>{item.label}: {item.value > 0 ? "+" : ""}{item.value.toFixed(1)}%</li>)}</ul>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="trades-title">
          <div className={styles.panelHeading}>
            <div><h2 id="trades-title">Example trades</h2><p className={styles.muted}>Trades are fabricated layout examples</p></div>
            <span className={styles.fixtureTag}>SAMPLE TRADES</span>
          </div>
          <div className={styles.panel}>
            {backtestTrades.map((trade) => (
              <article className={styles.record} key={`${trade.symbol}-${trade.entry}`}>
                <div className={styles.spread}><strong>{trade.symbol}</strong><strong className={trade.result.startsWith("−") ? styles.negative : styles.positive}>{trade.result}</strong></div>
                <dl className={styles.definitionGrid}>
                  <div><dt>Example entry</dt><dd>{trade.entry}</dd></div>
                  <div><dt>Example exit</dt><dd>{trade.exit}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.panel} aria-labelledby="limitations-title">
          <div className={styles.panelHeading}><h2 id="limitations-title">Honest results</h2><span className={styles.fixtureTag}>LIMITATIONS</span></div>
          <ul className={styles.panelStack}>{backtestLimitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        </section>
      </div>
    </FixtureScreen>
  );
}
