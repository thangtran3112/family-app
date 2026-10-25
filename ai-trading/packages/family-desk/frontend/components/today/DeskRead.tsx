import { fixtureBannerText } from "../../lib/fixtures/banner.ts";
import styles from "./today.module.css";

export function DeskRead() {
  return (
    <section className={styles.panel} aria-labelledby="desk-read-title">
      <header className={styles.panelHeading}>
        <h2 id="desk-read-title">Desk read</h2>
        <span className={styles.fixtureTag}>{fixtureBannerText()}</span>
      </header>
      <p className={styles.bodyText}>Daily market analysis is not connected yet.</p>
      <p className={styles.muted}>No AI analysis or recommendations have been generated.</p>
    </section>
  );
}
