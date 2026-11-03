import styles from "./screen.module.css";

/** What was scanned, stated plainly. It sits under the table. */
export function UniverseFootnote({ text }: { text: string }) {
  return <p className={styles.footnote}>{text}</p>;
}
