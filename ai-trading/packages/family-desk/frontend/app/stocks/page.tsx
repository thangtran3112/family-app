import { FixtureScreen } from "../../components/FixtureScreen.tsx";
import styles from "../../components/fixtures.module.css";
import { divergingBars, scalePercent } from "../../lib/fixtures/chart-geometry.ts";
import {
  stockAlertSettings,
  stockAnalystDistribution,
  stockBrief,
  stockEarningsReaction,
  stockEpsRevisions,
  stockLongTerm,
  stockTimeline,
  stockTrackRecord,
  stockValuation,
  stockVoting,
} from "../../lib/fixtures/stocks.ts";

export default function StocksPage() {
  const targetRange = stockLongTerm.priceTargetComparison;
  const earningsBars = divergingBars(stockEarningsReaction.quarters.map((quarter) => ({ label: quarter.quarter, value: quarter.excess })));

  return (
    <FixtureScreen phase={5} title={`${stockLongTerm.symbol} · ${stockLongTerm.company}`}>
      <div className={styles.content}>
        <section className={styles.section} aria-label="Sample stock overview">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>SAMPLE POSITION · ILLUSTRATIVE VALUES</p>
              <strong className={styles.statValue}>{stockLongTerm.last}</strong>
              <p className={styles.positive}>{stockLongTerm.change}</p>
              <p className={styles.muted}>{stockLongTerm.position}</p>
            </div>
            <span className={styles.fixtureTag}>NOT MARKET DATA</span>
          </div>
          <nav className={styles.navPills} aria-label="Stock research views">
            <a href="#long-term">Long-term view</a>
            <a href="#daily-brief">Daily brief</a>
            <a href="#track-record">Track record</a>
            <a href="#valuation">Valuation</a>
            <a href="#timeline">Timeline</a>
          </nav>
        </section>

        <section className={`${styles.panel} ${styles.panelStack}`} id="long-term" aria-labelledby="long-term-title">
          <div className={styles.panelHeading}>
            <div><h2 id="long-term-title">Desk AI · long-term view</h2><p className={styles.muted}>{stockLongTerm.horizon}</p></div>
            <span className={`${styles.fixtureTag} ${styles.accent}`}>SAMPLE VERDICT</span>
          </div>
          <div className={styles.cards2}>
            <div className={styles.panelStack}>
              <div className={styles.spread}>
                <strong className={styles.statValue}>{stockLongTerm.rating.toUpperCase()}</strong>
                <span className={styles.pill}>{stockLongTerm.confidence} sample confidence</span>
              </div>
              <p className={styles.bodyText}>{stockLongTerm.ratingChange.from} → {stockLongTerm.ratingChange.to} · target {stockLongTerm.ratingChange.previousTarget} → {stockLongTerm.priceTargetComparison.deskTarget} ({stockLongTerm.ratingChange.targetChange})</p>
              <span className={styles.fixtureTag}>FICTIONAL COMMITTEE VERDICT</span>
            </div>
            <div className={styles.warning}>
              <strong>Sample decision reasoning</strong>
              <ul>{stockLongTerm.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
            </div>
          </div>
          <div>
            <div className={styles.panelHeading}><h3>Price vs. target range</h3><span className={styles.fixtureTag}>SAMPLE PRICES</span></div>
            <div className={styles.comparisonPlot} role="img" aria-label={`Sample current price $${targetRange.currentPrice}; analyst mean $${targetRange.analystMean}; Desk AI target $${targetRange.deskTarget}`}>
              <span className={styles.comparisonTrack} />
              <span className={styles.comparisonMarker} style={{ left: `${scalePercent(targetRange.currentPrice, targetRange.low, targetRange.high)}%` }} />
              <span className={`${styles.comparisonMarker} ${styles.analystMean}`} style={{ left: `${scalePercent(targetRange.analystMean, targetRange.low, targetRange.high)}%` }} />
              <span className={`${styles.comparisonMarker} ${styles.aiTarget}`} style={{ left: `${scalePercent(targetRange.deskTarget, targetRange.low, targetRange.high)}%` }} />
            </div>
            <ul className={styles.chartDataList}>
              <li>Range ${targetRange.low}–${targetRange.high}</li><li>Sample price ${targetRange.currentPrice}</li>
              <li>Analyst mean ${targetRange.analystMean}</li><li>Desk AI target ${targetRange.deskTarget}</li>
            </ul>
          </div>
          <div className={styles.cards2}>
            <section className={`${styles.panel} ${styles.panelStack}`} aria-labelledby="committee-title">
              <div className={styles.panelHeading}><h3 id="committee-title">Voting &amp; reasoning</h3><span className={styles.fixtureTag}>{stockVoting.panel}</span></div>
              {stockVoting.votes.map((vote) => (
                <div className={styles.voteRow} key={vote.seat}>
                  <strong>{vote.seat}</strong><span className={styles.pill}>{vote.vote}</span><span className={styles.detail}>{vote.reason}</span>
                </div>
              ))}
              <strong>{stockVoting.result}</strong>
            </section>
            <section className={`${styles.panel} ${styles.panelStack}`} aria-labelledby="analysts-title">
              <div className={styles.panelHeading}><h3 id="analysts-title">Analyst distribution</h3><span className={styles.fixtureTag}>SAMPLE CONSENSUS</span></div>
              <div className={styles.distribution}>
                {stockAnalystDistribution.map((item) => (
                  <div className={styles.distributionRow} key={item.rating}>
                    <span>{item.rating}</span>
                    <span className={styles.distributionTrack}><span className={styles.distributionFill} style={{ width: `${(item.count / 18) * 100}%` }} /></span>
                    <strong>{item.count}</strong>
                  </div>
                ))}
              </div>
              <p className={styles.footnote}>41 sample analyst ratings. Counts are display fixtures.</p>
            </section>
          </div>
          <section className={styles.section} aria-labelledby="eps-revisions-title">
            <div className={styles.panelHeading}><h3 id="eps-revisions-title">Consensus EPS &amp; revisions</h3><span className={styles.fixtureTag}>SAMPLE ESTIMATES</span></div>
            {stockEpsRevisions.map((revision) => (
              <article className={styles.record} key={revision.period}>
                <div className={styles.spread}><strong>{revision.period}</strong><strong>{revision.estimate} EPS</strong></div>
                <dl className={styles.definitionGrid}>
                  <div><dt>7-day revision</dt><dd>{revision.sevenDays}</dd></div><div><dt>30-day revision</dt><dd>{revision.thirtyDays}</dd></div>
                  <div><dt>90-day revision</dt><dd>{revision.ninetyDays}</dd></div><div><dt>Actual</dt><dd>{revision.actual ?? "Not reported · sample"}</dd></div>
                </dl>
              </article>
            ))}
          </section>
          <fieldset className={`${styles.panel} ${styles.panelStack}`} disabled aria-describedby="stock-alert-note">
            <legend className={styles.recordTitle}>Alert settings · Phase 5</legend>
            <span className={styles.fixtureTag}>SAMPLE PREFERENCES · DISABLED</span>
            {stockAlertSettings.map((setting) => (
              <label className={styles.spread} key={setting.label}>
                <span>{setting.label}</span><input type="checkbox" checked={setting.enabled} readOnly />
              </label>
            ))}
            <p className={styles.footnote} id="stock-alert-note">Settings are shown for layout only and cannot be changed here.</p>
          </fieldset>
          <p className={styles.footnote}>{stockLongTerm.target} · {stockLongTerm.upside} · analyst mean {stockLongTerm.analystMean}</p>
        </section>

        <section className={styles.section} id="daily-brief" aria-labelledby="brief-title">
          <div className={styles.panelHeading}>
            <div><h2 id="brief-title">Desk AI daily brief</h2><p className={styles.muted}>{stockBrief.date}</p></div>
            <span className={styles.fixtureTag}>SAMPLE BRIEF</span>
          </div>
          <div className={styles.cards2}>
            <div className={styles.panelStack}>
              <div className={styles.navPills} aria-label="Sample brief counts">
                {stockBrief.counts.map((count) => <span className={styles.pill} key={count}>{count}</span>)}
              </div>
              {stockBrief.verdicts.map((item) => (
                <article className={`${styles.panel} ${styles.panelStack}`} key={item.symbol}>
                  <div className={styles.spread}><h3>{item.symbol}</h3><span className={styles.fixtureTag}>SAMPLE · {item.verdict.toUpperCase()} {item.change}</span></div>
                  <dl className={styles.definitionGrid}>
                    <div><dt>AI target</dt><dd>{item.target}</dd></div><div><dt>Upside</dt><dd>{item.upside}</dd></div>
                    <div><dt>Confidence</dt><dd>{item.confidence}</dd></div><div><dt>EPS revision</dt><dd>{item.revision}</dd></div>
                    <div><dt>Next earnings</dt><dd>{item.earnings}</dd></div>
                  </dl>
                  <p className={styles.bodyText}>{item.summary}</p>
                </article>
              ))}
            </div>
            <aside className={`${styles.panel} ${styles.panelStack}`} aria-labelledby="daily-alerts-title">
              <div className={styles.panelHeading}><h3 id="daily-alerts-title">Alert rail</h3><span className={styles.fixtureTag}>SAMPLE ALERTS</span></div>
              <div className={styles.alertRail}>
                {stockBrief.alerts.map((alert) => <article className={styles.alertItem} key={`${alert.symbol}-${alert.time}`}><div className={styles.spread}><strong>{alert.symbol}</strong><span className={styles.detail}>{alert.time}</span></div><p className={styles.bodyText}>{alert.text}</p></article>)}
              </div>
            </aside>
          </div>
        </section>

        <section className={styles.section} id="track-record" aria-labelledby="track-record-title">
          <div className={styles.panelHeading}>
            <div><h2 id="track-record-title">Desk AI track record</h2><p className={styles.muted}>{stockTrackRecord.description}</p></div>
            <span className={styles.fixtureTag}>SAMPLE HISTORY</span>
          </div>
          <div className={styles.summaryGrid}>
            {stockTrackRecord.summary.map((item) => (
              <div className={styles.stat} key={item.label}>
                <span className={styles.statLabel}>{item.label}</span><strong className={styles.statValue}>{item.value}</strong>
              </div>
            ))}
          </div>
          <div className={styles.cards3}>
            {stockTrackRecord.ratings.map((row) => (
              <article className={`${styles.panel} ${styles.panelStack}`} key={row.rating}>
                <div className={styles.spread}><h3>{row.rating}</h3><span className={styles.fixtureTag}>SETTLED SAMPLE</span></div>
                <dl className={styles.definitionGrid}>
                  <div><dt>Calls</dt><dd>{row.calls}</dd></div><div><dt>Outperformed</dt><dd>{row.outperform}</dd></div><div><dt>Excess return</dt><dd>{row.excessReturn}</dd></div>
                </dl>
              </article>
            ))}
          </div>
          <div className={styles.cards2}>
            <article className={`${styles.panel} ${styles.panelStack}`}>
              <div className={styles.panelHeading}><h3>Confidence calibration</h3><span className={styles.fixtureTag}>SETTLED SAMPLE</span></div>
              {stockTrackRecord.confidenceCalibration.map((row) => <div className={styles.spread} key={row.band}><span>{row.band} · n={row.sampleSize}</span><strong>{row.hitRate} hit rate</strong></div>)}
            </article>
            <article className={`${styles.panel} ${styles.panelStack}`}>
              <div className={styles.panelHeading}><h3>Targets reached</h3><span className={styles.fixtureTag}>FIXTURE</span></div>
              <strong className={styles.statValue}>{stockTrackRecord.targetHitRate.rate}</strong>
              <p className={styles.bodyText}>{stockTrackRecord.targetHitRate.reached} of {stockTrackRecord.targetHitRate.matured} matured sample calls reached their base target.</p>
            </article>
          </div>
          <div className={styles.panel}>
            <div className={styles.panelHeading}><h3>Recent settled calls &amp; lessons</h3><span className={styles.fixtureTag}>SAMPLE SETTLEMENTS</span></div>
            <div className={styles.alertRail}>
              {stockTrackRecord.settledLessons.map((item) => <article className={styles.alertItem} key={`${item.date}-${item.symbol}`}><div className={styles.spread}><strong>{item.date} · {item.symbol} · {item.call}</strong><span>{item.return} vs benchmark {item.benchmark}</span></div><p className={styles.detail}>{item.lesson}</p></article>)}
            </div>
          </div>
          <p className={styles.footnote}>Lessons are shown for review; no sample result is fed back into a model.</p>
        </section>

        <section className={`${styles.panel} ${styles.panelStack}`} id="valuation" aria-labelledby="valuation-title">
          <div className={styles.panelHeading}>
            <div><h2 id="valuation-title">Valuation &amp; earnings reaction</h2><p className={styles.muted}>Illustrative methods and sample multiples</p></div>
            <span className={styles.fixtureTag}>NOT FINANCIAL DATA</span>
          </div>
          <dl className={styles.definitionGrid}>
            {stockValuation.ratios.map((ratio) => <div key={ratio.label}><dt>{ratio.label}</dt><dd>{ratio.value}</dd></div>)}
          </dl>
          <div className={styles.cards3}>
            {stockValuation.methods.map((method) => (
              <article className={`${styles.panel} ${styles.panelStack}`} key={method.name}>
                <h3>{method.name}</h3><strong className={styles.statValue}>{method.target}</strong><p className={styles.detail}>{method.note}</p>
              </article>
            ))}
          </div>
          <div className={styles.panel}>
            <div className={styles.panelHeading}><h3>Blended intrinsic value</h3><span className={styles.fixtureTag}>ILLUSTRATIVE MODEL</span></div>
            <div className={styles.spread}><strong className={styles.statValue}>{stockValuation.blend.value}</strong><span>{stockValuation.blend.dcfWeight} DCF · {stockValuation.blend.otherMethodsWeight} other methods</span></div>
            <p className={styles.bodyText}>Sample price {stockValuation.blend.price} · {stockValuation.blend.versusValue} the blended value</p>
            <div className={styles.cards3}>
              {stockValuation.scenarios.map((scenario) => <article className={`${styles.panel} ${styles.panelStack}`} key={scenario.name}><div className={styles.spread}><h3>{scenario.name}</h3><strong>{scenario.value}</strong></div><p className={styles.detail}>{scenario.assumption}</p></article>)}
            </div>
            <dl className={styles.definitionGrid}>
              {stockValuation.assumptions.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
            </dl>
          </div>
          <p className={styles.footnote}>{stockValuation.note}</p>
        </section>

        <section className={`${styles.panel} ${styles.panelStack}`} aria-labelledby="earnings-reaction-title">
          <div className={styles.panelHeading}><div><h2 id="earnings-reaction-title">Earnings reaction</h2><p className={styles.muted}>{stockEarningsReaction.heading}</p></div><span className={styles.fixtureTag}>SYNTHETIC RETURNS</span></div>
          <div className={styles.cards3}>
            <div><span className={styles.statLabel}>Average absolute move</span><strong>{stockEarningsReaction.averageAbsoluteMove}</strong></div>
            <div><span className={styles.statLabel}>Average excess vs benchmark</span><strong>{stockEarningsReaction.averageExcessVsBenchmark}</strong></div>
            <div><span className={styles.statLabel}>Beat / miss sample</span><strong>{stockEarningsReaction.beats} · {stockEarningsReaction.misses}</strong></div>
          </div>
          <div className={styles.zeroChart} role="img" aria-label="Synthetic quarterly earnings excess returns around zero">
            {earningsBars.map((bar) => (
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
          <ul className={styles.chartDataList}>{stockEarningsReaction.quarters.map((quarter) => <li key={quarter.quarter}>{quarter.quarter}: excess {quarter.excess > 0 ? "+" : ""}{quarter.excess}% · move {quarter.move > 0 ? "+" : ""}{quarter.move}%</li>)}</ul>
          <p className={styles.footnote}>Next earnings: {stockEarningsReaction.impliedMove} · fabricated example, not an options-implied quote.</p>
        </section>

        <section className={`${styles.panel} ${styles.panelStack}`} id="timeline" aria-labelledby="timeline-title">
          <div className={styles.panelHeading}>
            <div><h2 id="timeline-title">Stock timeline</h2><p className={styles.muted}>Sample events and notes</p></div>
            <span className={styles.fixtureTag}>ILLUSTRATIVE TIMELINE</span>
          </div>
          <ol className={styles.timeline}>
            {stockTimeline.map((event) => (
              <li key={`${event.type}-${event.date}`}>
                <div><span className={styles.eyebrow}>{event.type}</span><span className={styles.detail}>{event.date}</span></div>
                <p className={styles.bodyText}>{event.text}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </FixtureScreen>
  );
}
