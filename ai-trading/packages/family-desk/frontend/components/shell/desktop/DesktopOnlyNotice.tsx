import styles from "./DesktopOnlyNotice.module.css";

/** Desktop-only routes on a phone: no mobile layout is built for them (02m §e). */
export function DesktopOnlyNotice() {
  return (
    <div className={styles.panel}>
      <h1 className={styles.title}>This screen is built for a larger window</h1>
      <p className={styles.body}>Open the Desk in a desktop browser (1100 px wide or more) to use it.</p>
    </div>
  );
}
