import { FixtureScreen } from "../../components/FixtureScreen.tsx";
import styles from "../../components/fixtures.module.css";
import { coveredCallCandidates, coveredCallOverview, monthlyPremiums, rollCandidates, shortCallRisks } from "../../lib/fixtures/covered-calls.ts";

export default function CoveredCallsPage() {
  return (
    <FixtureScreen phase={5} title="Covered calls">
      <div className={styles.content}>
        <nav className={styles.navPills} aria-label="Covered-call views">
          <a href="#scan" aria-current="location">Daily scan</a>
          <a href="#short-calls">Open short calls</a>
          <a href="#income">Income history</a>
        </nav>

        <section className={styles.section} aria-labelledby="scan-title">
          <div className={styles.panelHeading}>
            <div><h2 id="scan-title">Daily scan</h2><p className={styles.muted}>Illustrative candidate set · no options feed connected</p></div>
            <span className={styles.fixtureTag}>DEMO SCAN</span>
          </div>
          <div className={styles.summaryGrid}>
            {coveredCallOverview.map((item) => (
              <div className={styles.stat} key={item.label}>
                <span className={styles.statLabel}>{item.label}</span>
                <strong className={styles.statValue}>{item.value}</strong>
              </div>
            ))}
          </div>
          <div className={styles.cards2} id="scan">
            {coveredCallCandidates.map((candidate) => (
              <article className={`${styles.panel} ${styles.panelStack}`} key={candidate.symbol}>
                <div className={styles.panelHeading}>
                  <div><h3>{candidate.symbol}</h3><p className={styles.muted}>{candidate.account} · {candidate.shares}</p></div>
                  <span className={`${styles.pill} ${candidate.status === "Opportunity" ? styles.positive : candidate.status === "Desk AI: Sell" ? styles.negative : styles.amber}`}>{candidate.status}</span>
                </div>
                <span className={styles.fixtureTag}>SAMPLE CANDIDATE</span>
                <dl className={styles.definitionGrid}>
                  <div><dt>Contract</dt><dd>{candidate.strike}</dd></div>
                  <div><dt>Expiry</dt><dd>{candidate.expiry}</dd></div>
                  <div><dt>Delta</dt><dd>{candidate.delta}</dd></div>
                  <div><dt>Sample bid / ask</dt><dd>{candidate.bidAsk}</dd></div>
                  <div><dt>Yield</dt><dd>{candidate.yield}</dd></div>
                  <div><dt>Review flags</dt><dd>{candidate.flags}</dd></div>
                </dl>
              </article>
            ))}
          </div>
          <div className={styles.warning}>Sample numbers do not come from quotes. The scanner and alerts are wired in Phase 5.</div>
          <button className={styles.button} type="button" disabled aria-label="Run covered-call scan, available in Phase 5">Run scan · Phase 5</button>
        </section>

        <section className={styles.section} id="short-calls" aria-labelledby="short-calls-title">
          <div className={styles.panelHeading}>
            <div><h2 id="short-calls-title">Open short calls · risk monitor</h2><p className={styles.muted}>Sample contracts and alert states</p></div>
            <span className={styles.fixtureTag}>DEMO RISK PANEL</span>
          </div>
          <div className={styles.panel}>
            {shortCallRisks.map((call) => (
              <article className={styles.record} key={call.contract}>
                <div className={styles.spread}>
                  <div><h3 className={styles.recordTitle}>{call.contract}</h3><p className={styles.recordSubtitle}>{call.account}</p></div>
                  <span className={`${styles.pill} ${call.status === "Risk" ? styles.negative : ""}`}>{call.status}</span>
                </div>
                <dl className={styles.definitionGrid}>
                  <div><dt>Days to expiry</dt><dd>{call.dte}</dd></div>
                  <div><dt>Sample spot</dt><dd>{call.spot}</dd></div>
                  <div><dt>Delta</dt><dd>{call.delta}</dd></div>
                  <div><dt>Sample review</dt><dd>{call.note}</dd></div>
                </dl>
                {call.status === "Risk" ? <p className={styles.warning}>Example alert only · no action has been taken</p> : null}
              </article>
            ))}
          </div>
          <section className={`${styles.panel} ${styles.panelStack}`} aria-labelledby="roll-title">
            <div className={styles.panelHeading}>
              <h3 id="roll-title">Roll candidates · sample close price $0.52</h3>
              <span className={styles.fixtureTag}>NOT A QUOTE</span>
            </div>
            {rollCandidates.map((candidate) => (
              <article className={styles.record} key={candidate.expiry}>
                <div className={styles.spread}><strong>{candidate.expiry}</strong><span>{candidate.credit}</span></div>
                <p className={styles.detail}>Sample bid {candidate.bid} · {candidate.flag}</p>
              </article>
            ))}
            <p className={styles.footnote}>Rolling and alert delivery are not available from this fixture panel.</p>
            <div className={styles.buttonRow}>
              <button className={styles.button} type="button" disabled aria-label="Paper roll, available in a later phase">Paper roll · later phase</button>
              <button className={styles.buttonSecondary} type="button" disabled aria-label="Create a short-call alert, available in Phase 5">Alert me · Phase 5</button>
            </div>
          </section>
        </section>

        <section className={styles.section} id="income" aria-labelledby="income-title">
          <div className={styles.panelHeading}>
            <div><h2 id="income-title">Monthly premium · sample year</h2><p className={styles.muted}>Illustrative monthly totals, not account history</p></div>
            <span className={styles.fixtureTag}>SAMPLE SERIES</span>
          </div>
          <div className={styles.panel}>
            <div className={styles.barChart} role="img" aria-label="Sample monthly premium values">
              {monthlyPremiums.map((item) => (
                <div className={styles.barItem} key={item.month}>
                  <span>{item.value}</span>
                  <span className={styles.bar} style={{ height: `${Math.max(24, Number.parseInt(item.value.replace(/[^0-9]/g, ""), 10) / 10)}%` }} />
                  <span>{item.month}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </FixtureScreen>
  );
}
