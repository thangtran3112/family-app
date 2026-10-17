import { FixtureScreen } from "../../components/FixtureScreen.tsx";
import styles from "../../components/fixtures.module.css";
import { backtestMetrics, backtestMonthly, backtestSettings, backtestTrades } from "../../lib/fixtures/backtests.ts";

export default function BacktestsPage() {
  return (
    <FixtureScreen phase="6b" title="Backtest">
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
          <button className={styles.button} type="button" disabled aria-label="Run backtest, available in Phase 6b">Run backtest · Phase 6b</button>
          <p className={styles.footnote}>Backtesting is not wired yet. Values below are fabricated examples, not results from this strategy.</p>
        </section>

        <section className={styles.section} aria-labelledby="backtest-summary-title">
          <div className={styles.panelHeading}>
            <h2 id="backtest-summary-title">Example metrics</h2>
            <span className={styles.fixtureTag}>NOT A STRATEGY RESULT</span>
          </div>
          <div className={styles.cards3}>
            {backtestMetrics.map((metric) => (
              <article className={styles.panel} key={metric.label}>
                <span className={styles.statLabel}>{metric.label}</span>
                <strong className={styles.statValue}>{metric.value}</strong>
                <span className={styles.statDetail}>Illustrative only</span>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="monthly-title">
          <div className={styles.panelHeading}>
            <div><h2 id="monthly-title">Monthly returns</h2><p className={styles.muted}>Invented sample series</p></div>
            <span className={styles.fixtureTag}>DEMO CHART</span>
          </div>
          <div className={styles.panel}>
            <div className={styles.barChart} role="img" aria-label="Illustrative monthly backtest returns">
              {backtestMonthly.map((item, index) => (
                <div className={styles.barItem} key={item.month}>
                  <span>{item.result}</span>
                  <span className={styles.bar} style={{ height: `${32 + index * 9}%`, background: item.result.startsWith("−") ? "var(--color-down, #ff453a)" : "var(--color-up, #30d158)" }} />
                  <span>{item.month}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="trades-title">
          <div className={styles.panelHeading}>
            <div><h2 id="trades-title">Example trades</h2><p className={styles.muted}>Trades are made up for layout review</p></div>
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
      </div>
    </FixtureScreen>
  );
}
