import type { Metadata } from "next";
import { FixtureScreen } from "../../components/FixtureScreen.tsx";
import styles from "../../components/fixtures.module.css";
import { paperFillJournal, paperPositions, paperStrategies, paperSummary } from "../../lib/fixtures/paper.ts";

export const metadata: Metadata = { title: "Paper trading" };

export default function PaperPage() {
  return (
    <FixtureScreen title="Paper trading">
      <div className={styles.content}>
        <div className={styles.sectionHeading}>
          <nav className={styles.navPills} aria-label="Paper views">
            <a href="#paper-trades" aria-current="location">Paper trades</a>
            <a href="/backtests">Backtests · not available yet</a>
          </nav>
          <p className={styles.muted}>IBKR not configured · no broker actions available</p>
        </div>

        <section className={styles.section} aria-label="Sample paper summary">
          <div className={styles.panelHeading}>
            <h2>Sample activity</h2>
            <span className={styles.fixtureTag}>ILLUSTRATIVE</span>
          </div>
          <div className={styles.summaryGrid}>
            {paperSummary.map((item) => (
              <div className={styles.stat} key={item.label}>
                <span className={styles.statLabel}>{item.label}</span>
                <strong className={styles.statValue}>{item.value}</strong>
                <span className={styles.statDetail}>{item.detail}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.section} id="paper-trades" aria-labelledby="positions-title">
          <div className={styles.panelHeading}>
            <h2 id="positions-title">Open positions</h2>
            <span className={styles.fixtureTag}>SAMPLE RECORDS</span>
          </div>
          <div className={styles.panel}>
            {paperPositions.map((position) => (
              <article className={styles.record} key={position.symbol}>
                <div className={styles.spread}>
                  <div>
                    <h3 className={styles.recordTitle}>{position.symbol}</h3>
                    <p className={styles.recordSubtitle}>{position.strategy}</p>
                  </div>
                  <span className={styles.pill}>{position.side}</span>
                </div>
                <dl className={styles.definitionGrid}>
                  <div><dt>Sample entry</dt><dd>{position.entry}</dd></div>
                  <div><dt>Sample last</dt><dd>{position.last}</dd></div>
                  <div><dt>Stop</dt><dd>{position.stop}</dd></div>
                  <div><dt>Target</dt><dd>{position.target}</dd></div>
                  <div><dt>Sample open P&amp;L</dt><dd className={styles.positive}>{position.pnl}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="fill-journal-title">
          <div className={styles.panelHeading}>
            <div><h2 id="fill-journal-title">Fill journal</h2><p className={styles.muted}>Every sample fill points back to its immutable strategy version and signal.</p></div>
            <span className={styles.fixtureTag}>PROVENANCE EXAMPLES</span>
          </div>
          <div className={styles.panel}>
            {paperFillJournal.map((fill) => (
              <article className={styles.record} key={fill.signalId}>
                <div className={styles.spread}><span className={styles.recordSubtitle}>{fill.time} · {fill.action}</span><span className={styles.fixtureTag}>SAMPLE JOURNAL</span></div>
                <strong>{fill.order}</strong>
                <dl className={styles.definitionGrid}>
                  <div><dt>Strategy</dt><dd>{fill.strategy} · {fill.version}</dd></div>
                  <div><dt>Signal provenance</dt><dd>{fill.signalId} · {fill.signal}</dd></div>
                </dl>
                <p className={styles.detail}>{fill.note}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="strategy-results-title">
          <div className={styles.panelHeading}>
            <h2 id="strategy-results-title">By strategy · sample period</h2>
            <span className={styles.fixtureTag}>NOT PERFORMANCE HISTORY</span>
          </div>
          <div className={styles.cards3}>
            {paperStrategies.map((strategy) => (
              <article className={`${styles.panel} ${styles.panelStack}`} key={strategy.name}>
                <div className={styles.spread}>
                  <h3>{strategy.name}</h3>
                  <span className={styles.fixtureTag}>SAMPLE</span>
                </div>
                <dl className={styles.definitionGrid}>
                  <div><dt>Trades</dt><dd>{strategy.trades}</dd></div>
                  <div><dt>Win rate</dt><dd>{strategy.winRate}</dd></div>
                  <div><dt>Average</dt><dd>{strategy.average}</dd></div>
                  <div><dt>P&amp;L</dt><dd className={styles.positive}>{strategy.pnl}</dd></div>
                  <div><dt>Max drawdown</dt><dd>{strategy.drawdown}</dd></div>
                  <div><dt>Stage</dt><dd>{strategy.status}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.panel} aria-labelledby="paper-control-title">
          <div className={styles.panelHeading}>
            <h2 id="paper-control-title">Paper controls</h2>
            <span className={styles.fixtureTag}>FIXTURE ONLY</span>
          </div>
          <p className={styles.bodyText}>These controls are display-only in this phase. No account is connected and no order can be submitted.</p>
          <div className={styles.buttonRow}>
            <button className={styles.button} type="button" disabled aria-describedby="paper-action-note">Pause all strategies · needs broker setup</button>
            <button className={styles.buttonSecondary} type="button" disabled aria-describedby="paper-action-note">Place paper order · needs broker setup</button>
          </div>
          <p className={styles.footnote} id="paper-action-note">Actions stay disabled until broker setup is finished.</p>
        </section>
      </div>
    </FixtureScreen>
  );
}
