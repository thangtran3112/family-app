import { timeline } from "@/lib/desk/feedbackView";
import type { FeedbackEvent } from "@/lib/feedback/schemas";
import styles from "./feedback.module.css";

/** Open, In progress, Fixed (02s): one row per recorded status change. The agent chip is the only place `--color-ai` appears besides the agent line. */
export function StatusTimeline({ events }: { events: readonly FeedbackEvent[] }) {
  return (
    <ol className={styles.timeline} aria-label="Status history">
      {timeline(events).map((entry) => (
        <li key={entry.key} className={styles.step} data-current={entry.current}>
          <span className={styles.dot} aria-hidden="true" />
          <div className={styles.stepBody}>
            <span className={styles.stepLabel}>{entry.label}</span>
            {entry.agent && <span className={styles.agentChip}>{entry.agent}</span>}
            {entry.note && <span className={styles.stepNote}>{entry.note}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
