import styles from "./Settings.module.css";

const fixtures = {
  offSwitch: {
    title: "Strategy off switch",
    detail: "Runtime pause controls are not available yet.",
    needs: "Needs broker setup",
  },
  dailyCap: {
    title: "Daily order cap",
    detail: "Order limits are not enforced by this screen.",
    needs: "Needs broker setup",
  },
  paperGuard: {
    title: "Paper guard",
    detail: "Paper-order safety checks are not active here.",
    needs: "Needs broker setup",
  },
  askBudget: {
    title: "Ask budget",
    detail: "Usage limits are not shown or enforced yet.",
    needs: "Not available yet",
  },
} as const;

type FixtureName = keyof typeof fixtures;

export function Fixtures({ items = ["offSwitch", "dailyCap", "paperGuard", "askBudget"] }: Readonly<{ items?: readonly FixtureName[] }>) {
  return (
    <section className={styles.fixtureSection} aria-labelledby="future-controls-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="future-controls-title">Future controls</h2>
          <p className={styles.helper}>Disabled fixtures only. These controls do not change runtime behavior.</p>
        </div>
        <span className={styles.fixtureTag}>NOT ACTIVE</span>
      </div>
      <div className={styles.fixtureList}>
        {items.map((key) => {
          const fixture = fixtures[key];
          const noteId = `fixture-note-${key}`;
          return (
            <article className={styles.fixtureRow} key={key}>
              <div>
                <h3 className={styles.rowTitle}>{fixture.title}</h3>
                <p className={styles.helper} id={noteId}>{fixture.detail}</p>
              </div>
              <button className={styles.fixtureButton} type="button" disabled aria-describedby={noteId}>
                {fixture.needs}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
