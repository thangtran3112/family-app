import type { Metadata } from "next";
import { FixtureScreen } from "../../components/FixtureScreen.tsx";
import styles from "../../components/fixtures.module.css";
import { assignmentHistory, coveredCallCandidates, coveredCallOverview, coveredCallPayoff, monthlyPremiums, rollCandidates, shortCallRisks, weeklyDigest } from "../../lib/fixtures/covered-calls.ts";

export const metadata: Metadata = { title: "Covered calls" };

export default function CoveredCallsPage() {
  return (
    <FixtureScreen title="Covered calls">
      <div className={styles.content}>
        <nav className={styles.navPills} aria-label="Covered-call views">
          <a href="#scan">Daily scan</a>
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
                  <div><h3>{candidate.symbol}</h3><p className={styles.muted}>{candidate.account} · {candidate.shares}{candidate.rank ? ` · rank #${candidate.rank}` : ""}</p></div>
                  <span className={`${styles.pill} ${candidate.status === "Opportunity" ? styles.positive : candidate.status === "Desk AI: Sell" ? styles.negative : styles.amber}`}>{candidate.status}</span>
                </div>
                <span className={styles.fixtureTag}>SAMPLE CANDIDATE</span>
                <dl className={styles.definitionGrid}>
                  <div><dt>Sample score</dt><dd>{candidate.score}</dd></div>
                  <div><dt>Contract</dt><dd>{candidate.strike}</dd></div>
                  <div><dt>Expiry</dt><dd>{candidate.expiry}</dd></div>
                  <div><dt>Delta</dt><dd>{candidate.delta}</dd></div>
                  <div><dt>Sample bid / ask</dt><dd>{candidate.bidAsk}</dd></div>
                  <div><dt>Yield</dt><dd>{candidate.yield}</dd></div>
                  <div><dt>Breakeven</dt><dd>{candidate.breakeven}</dd></div>
                  <div><dt>Upside cap</dt><dd>{candidate.cap}</dd></div>
                  <div><dt>Review flags</dt><dd>{candidate.flags}</dd></div>
                </dl>
              </article>
            ))}
          </div>
          <div className={styles.warning}>Sample numbers do not come from quotes. The scanner and alerts are not available yet.</div>
          <button className={styles.button} type="button" disabled aria-label="Run covered-call scan, not available yet">Run scan · not available yet</button>
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
              <button className={styles.buttonSecondary} type="button" disabled aria-label="Create a short-call alert, not available yet">Alert me · not available yet</button>
            </div>
          </section>
        </section>

        <section className={styles.section} aria-labelledby="payoff-title">
          <div className={styles.panelHeading}>
            <div><h2 id="payoff-title">Payoff &amp; breakeven</h2><p className={styles.muted}>{coveredCallPayoff.underlying} · {coveredCallPayoff.contract}</p></div>
            <span className={styles.fixtureTag}>SYNTHETIC EXPIRY SCENARIOS</span>
          </div>
          <div className={`${styles.panel} ${styles.panelStack}`}>
            <div className={styles.spread}><strong>Breakeven {coveredCallPayoff.breakeven}</strong><strong>Upside capped at {coveredCallPayoff.cap}</strong></div>
            <div className={styles.cards2}>
              {coveredCallPayoff.scenarios.map((scenario) => (
                <article className={styles.record} key={scenario.underlyingAtExpiry}>
                  <span className={styles.detail}>Sample underlying at expiry</span><strong>{scenario.underlyingAtExpiry}</strong>
                  <span>Covered-call P&amp;L: {scenario.coveredCallPnl}</span>
                </article>
              ))}
            </div>
            <p className={styles.footnote}>Illustrative payoff only; excludes fees, taxes, early exercise, and changing volatility.</p>
          </div>
        </section>

        <div className={styles.cards2}>
          <section className={`${styles.panel} ${styles.panelStack}`} aria-labelledby="assignment-title">
            <div className={styles.panelHeading}><h2 id="assignment-title">Assignment history</h2><span className={styles.fixtureTag}>SAMPLE EVENTS</span></div>
            {assignmentHistory.map((item) => <article className={styles.record} key={`${item.symbol}-${item.detail}`}><strong>{item.symbol}</strong><p className={styles.bodyText}>{item.detail}</p></article>)}
          </section>
          <section className={`${styles.panel} ${styles.panelStack}`} aria-labelledby="digest-title">
            <div className={styles.panelHeading}><h2 id="digest-title">{weeklyDigest.title}</h2><span className={styles.fixtureTag}>PREVIEW ONLY</span></div>
            <p className={styles.bodyText}>{weeklyDigest.summary}</p>
            {weeklyDigest.calls.map((call) => <div className={styles.spread} key={call.symbol}><strong>{call.symbol} · {call.contract}</strong><span className={call.state === "At risk" ? styles.negative : styles.muted}>{call.state}</span></div>)}
            <p className={styles.footnote}>No digest is scheduled or sent by this fixture.</p>
          </section>
        </div>

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
                  <span className={styles.bar} style={{ height: `${Math.max(8, (Number.parseInt(item.value.replace(/[^0-9]/g, ""), 10) / 1210) * 100)}%` }} />
                  <span>{item.month}</span>
                </div>
              ))}
            </div>
            <ul className={styles.chartDataList}>{monthlyPremiums.map((item) => <li key={item.month}>{item.month}: {item.value} sample premium</li>)}</ul>
          </div>
        </section>
      </div>
    </FixtureScreen>
  );
}
