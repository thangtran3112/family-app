import { FixtureScreen } from "../FixtureScreen.tsx";
import styles from "../fixtures.module.css";
import { holdingCalls, holdings, holdingsSummary, taxLots } from "../../lib/fixtures/holdings.ts";


export function HoldingsMobile() {
  return (
    <FixtureScreen title="Holdings">
      <div className={styles.content}>
        <div className={styles.sectionHeading}>
          <p className={styles.muted}>Sample portfolio · account sources are not connected</p>
          <div className={styles.buttonRow}>
            <button className={styles.buttonSecondary} type="button" disabled aria-describedby="holdings-action-note">Upload CSV · not available yet</button>
            <button className={styles.button} type="button" disabled aria-describedby="holdings-action-note">Import from broker · needs broker setup</button>
          </div>
        </div>
        <p className={styles.footnote} id="holdings-action-note">Imports are unavailable in this fixture screen; sample values are not account data.</p>

        <section className={styles.section} aria-labelledby="holdings-summary-title">
          <div className={styles.panelHeading}>
            <h2 id="holdings-summary-title">Portfolio snapshot</h2>
            <span className={styles.fixtureTag}>ILLUSTRATIVE TOTALS</span>
          </div>
          <div className={styles.summaryGrid}>
            {holdingsSummary.map((item) => (
              <div className={styles.stat} key={item.label}>
                <span className={styles.statLabel}>{item.label}</span>
                <strong className={styles.statValue}>{item.value}</strong>
                {item.detail ? <span className={styles.statDetail}>{item.detail}</span> : null}
              </div>
            ))}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="positions-title">
          <div className={styles.panelHeading}>
            <h2 id="positions-title">Positions · all sample accounts</h2>
            <span className={styles.fixtureTag}>MADE-UP HOLDINGS</span>
          </div>
          <div className={styles.panel}>
            {holdings.map((holding) => (
              <article className={styles.record} key={holding.symbol}>
                <div className={styles.spread}>
                  <div>
                    <h3 className={styles.recordTitle}>{holding.symbol}</h3>
                    <p className={styles.recordSubtitle}>{holding.account}</p>
                  </div>
                  <span className={styles.fixtureTag}>SAMPLE</span>
                </div>
                <dl className={styles.definitionGrid}>
                  <div><dt>Shares</dt><dd>{holding.shares}</dd></div>
                  <div><dt>Average cost</dt><dd>{holding.avgCost}</dd></div>
                  <div><dt>Sample mark</dt><dd>{holding.last}</dd></div>
                  <div><dt>Gain</dt><dd className={styles.positive}>{holding.gain}</dd></div>
                  <div><dt>Weight</dt><dd>{holding.weight}</dd></div>
                  <div><dt>Covered calls</dt><dd>{holding.coverage}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </section>

        <div className={styles.cards2}>
          <section className={`${styles.panel} ${styles.panelStack}`} aria-labelledby="lots-title">
            <div className={styles.panelHeading}>
              <h2 id="lots-title">AAPL tax lots</h2>
              <span className={styles.fixtureTag}>SAMPLE LOTS</span>
            </div>
            {taxLots.map((lot) => (
              <div className={styles.record} key={`${lot.shares}-${lot.account}`}>
                <strong>{lot.shares} @ {lot.cost} · {lot.account}</strong>
                <span className={styles.detail}>{lot.note}</span>
              </div>
            ))}
          </section>
          <section className={`${styles.panel} ${styles.panelStack}`} aria-labelledby="calls-title">
            <div className={styles.panelHeading}>
              <h2 id="calls-title">Open short calls</h2>
              <span className={styles.fixtureTag}>SAMPLE CONTRACT</span>
            </div>
            {holdingCalls.map((call) => (
              <article className={styles.record} key={call.contract}>
                <div className={styles.spread}><strong>{call.contract}</strong><strong className={styles.positive}>{call.pnl}</strong></div>
                <p className={styles.bodyText}>{call.detail}</p>
              </article>
            ))}
          </section>
        </div>
      </div>
    </FixtureScreen>
  );
}
