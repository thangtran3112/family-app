import { FixtureScreen } from "../../components/FixtureScreen.tsx";
import styles from "../../components/fixtures.module.css";
import { askCandidates, askPrompt, askReply, conversations, strategyDraft } from "../../lib/fixtures/ask.ts";

export default function AskPage() {
  return (
    <FixtureScreen phase={7} title="Ask Desk AI">
      <div className={styles.content}>
        <div className={styles.cards2}>
          <aside className={`${styles.panel} ${styles.panelStack}`} aria-labelledby="conversations-title">
            <div className={styles.panelHeading}>
              <h2 id="conversations-title">Recent conversations</h2>
              <span className={styles.fixtureTag}>SAMPLE HISTORY</span>
            </div>
            {conversations.map((conversation, index) => (
              <article className={styles.record} key={conversation.title}>
                <strong>{conversation.title}</strong>
                <span className={styles.detail}>{conversation.detail}</span>
                {index === 0 ? <span className={styles.pill}>Selected sample</span> : null}
              </article>
            ))}
            <div>
              <span className={styles.statLabel}>Illustrative monthly budget</span>
              <strong>$4.10 of $25</strong>
              <div role="img" aria-label="Sample budget used: 16 percent" className={styles.barChart}>
                <span className={styles.bar} style={{ height: "16%" }} />
              </div>
            </div>
          </aside>

          <section className={`${styles.panel} ${styles.panelStack}`} aria-labelledby="conversation-title">
            <div className={styles.panelHeading}>
              <h2 id="conversation-title">AAPL covered call for November</h2>
              <span className={styles.fixtureTag}>ILLUSTRATIVE CHAT</span>
            </div>
            <blockquote className={styles.warning}>{askPrompt}</blockquote>
            <div className={styles.panelStack}>
              {askReply.map((paragraph) => <p className={styles.bodyText} key={paragraph}>{paragraph}</p>)}
            </div>

            <section className={styles.section} aria-labelledby="candidates-title">
              <div className={styles.panelHeading}>
                <h3 id="candidates-title">Covered-call candidates · sample values</h3>
                <span className={styles.fixtureTag}>NOT QUOTES</span>
              </div>
              {askCandidates.map((candidate) => (
                <article className={styles.record} key={candidate.strike}>
                  <div className={styles.spread}><strong>{candidate.strike}</strong><span>{candidate.expiry}</span></div>
                  <dl className={styles.definitionGrid}>
                    <div><dt>Sample bid</dt><dd>{candidate.bid}</dd></div>
                    <div><dt>Delta</dt><dd>{candidate.delta}</dd></div>
                    <div><dt>Annualized</dt><dd>{candidate.annualized}</dd></div>
                    <div><dt>Flags</dt><dd>{candidate.flags}</dd></div>
                  </dl>
                </article>
              ))}
            </section>

            <section className={styles.panelStack} aria-labelledby="draft-title">
              <div className={styles.panelHeading}>
                <div><h3 id="draft-title">{strategyDraft.name}</h3><p className={styles.muted}>{strategyDraft.version}</p></div>
                <span className={styles.fixtureTag}>NOT SAVED</span>
              </div>
              {strategyDraft.changes.map((change) => (
                <div className={styles.spread} key={change.field}>
                  <span>{change.field}</span><span className={styles.muted}>{change.before}</span><span aria-hidden="true">→</span><strong>{change.after}</strong>
                </div>
              ))}
              <p className={styles.footnote}>Drafting and saving strategies arrive in Phase 7. No change is stored.</p>
              <button className={styles.button} type="button" disabled aria-label="Save strategy draft, available in Phase 7">Save strategy · Phase 7</button>
            </section>

            <label className={styles.panelStack}>
              <span className={styles.statLabel}>Ask a question · available in Phase 7</span>
              <textarea className={styles.composer} aria-label="Ask Desk AI, unavailable in this fixture" disabled value="Chat is not connected in this fixture." readOnly />
            </label>
          </section>
        </div>
      </div>
    </FixtureScreen>
  );
}
