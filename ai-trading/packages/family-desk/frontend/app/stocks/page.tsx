import { FixtureScreen } from "../../components/FixtureScreen.tsx";
import styles from "../../components/fixtures.module.css";
import { stockBrief, stockLongTerm, stockTimeline, stockTrackRecord, stockValuation } from "../../lib/fixtures/stocks.ts";

export default function StocksPage() {
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
            <a href="#long-term" aria-current="location">Long-term view</a>
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
            <div className={styles.warning}><strong>{stockLongTerm.target}</strong><p className={styles.bodyText}>A model output example, not a recommendation.</p></div>
            <div className={styles.warning}><strong>{stockLongTerm.analystMean}</strong><p className={styles.bodyText}>Illustrative comparison only.</p></div>
          </div>
          <ul className={styles.panelStack}>
            {stockLongTerm.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
          </ul>
        </section>

        <section className={styles.section} id="daily-brief" aria-labelledby="brief-title">
          <div className={styles.panelHeading}>
            <div><h2 id="brief-title">Desk AI daily brief</h2><p className={styles.muted}>{stockBrief.date}</p></div>
            <span className={styles.fixtureTag}>SAMPLE BRIEF</span>
          </div>
          <div className={styles.navPills} aria-label="Sample brief counts">
            {stockBrief.counts.map((count) => <span className={styles.pill} key={count}>{count}</span>)}
          </div>
          <div className={styles.cards3}>
            {stockBrief.verdicts.map((item) => (
              <article className={`${styles.panel} ${styles.panelStack}`} key={item.symbol}>
                <div className={styles.spread}><h3>{item.symbol}</h3><span className={styles.fixtureTag}>SAMPLE · {item.verdict.toUpperCase()}</span></div>
                <strong>{item.confidence} example confidence</strong>
                <p className={styles.bodyText}>{item.summary}</p>
              </article>
            ))}
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
          <p className={styles.footnote}>{stockValuation.note}</p>
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
