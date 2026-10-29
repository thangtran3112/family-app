import { COPY } from "@/lib/desk/freshness";
import styles from "../fundamental.module.css";

/** Stands where a Desk AI verdict, brief row or change would be until the first daily run exists (02n §e): an honest state, never a sample. */
export function DeskAiNotStarted({ title = "Desk AI" }: { title?: string }) {
  return (
    <section className={`${styles.panel} ${styles.ai}`} aria-label={title}>
      <h2 className={styles.aiTitle}>{title}</h2>
      <p className={styles.muted} data-testid="desk-ai-not-started">{COPY.deskAiNotStarted}</p>
    </section>
  );
}
