import { todayPositionPreview } from "../../lib/fixtures/today-position.ts";
import styles from "./today.module.css";

export function PositionFixture() {
  const preview = todayPositionPreview();

  return (
    <section className={styles.fixturePosition} aria-labelledby="today-fixture-position-title">
      <header className={styles.fixturePositionHeader}>
        <div>
          <p className={styles.eyebrow}>PAPER POSITION CONTEXT</p>
          <h3 id="today-fixture-position-title">Illustrative · {preview.symbol}</h3>
        </div>
        <span className={styles.fixtureTag}>{preview.fixtureLabel}</span>
      </header>
      <p className={styles.fixturePositionNotice} role="note">{preview.notice}</p>
      <p className={styles.fixturePositionStrategy}>{preview.strategy}</p>
      <dl className={styles.fixturePositionLevels}>
        {preview.levels.map(({ label, value }) => (
          <div className={styles.fixturePositionLevel} key={label}>
            <dt><span className={styles.fixturePositionDash} aria-hidden="true" />{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <button className={styles.fixturePositionAction} type="button" disabled={!preview.controlsEnabled}>
        Position actions · Phase {preview.phase}
      </button>
    </section>
  );
}
