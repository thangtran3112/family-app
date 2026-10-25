import styles from "./day.module.css";

/** What was scanned, stated plainly. It sits under the list and under any score or ranking built from it. */
export function UniverseFootnote({ text }: { text: string }) {
  return <p className={styles.footnote}>{text}</p>;
}
