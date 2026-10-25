import { formatNumber } from "@/lib/desk/format";
import type { PlanItem } from "@/lib/replay/planView";
import styles from "./panels.module.css";

// The plan as live ticks (02o §a3): ✓ met, ! needs attention, • not yet, – off. The mark is decoration; the state is read aloud.
// Every rule of the thread plan has its row, a rule the plan leaves off reads Off or None (D-021).

const MARK = { ok: "✓", warn: "!", pending: "•", off: "–" } as const;
const STATE_WORDS = { ok: "Met", warn: "Needs attention", pending: "Not yet", off: "Not set" } as const;

export function PlanChecklist({
  items,
  shares,
  note,
  onAddStop,
}: {
  items: PlanItem[];
  shares: number;
  /** The plan note, if she wrote one. */
  note?: string | null;
  /** Opens the stop note for the open entry; offered beside a missing stop and never blocks the entry (D-022). */
  onAddStop?: () => void;
}) {
  return (
    <div>
      <ul className={styles.list}>
        <li className={styles.row}>
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.label}>Shares per trade</span>
          <span className={styles.detail}>{formatNumber(shares, 0)}</span>
        </li>
        {items.map((item) => (
          <li key={item.id} className={`${styles.row} ${item.action && onAddStop ? styles.wrap : ""}`} data-state={item.state}>
            <span className={styles.mark} data-state={item.state} aria-hidden="true">{MARK[item.state]}</span>
            <span className={styles.srOnly}>{STATE_WORDS[item.state]}: </span>
            <span className={styles.label}>{item.label}</span>
            <span className={styles.detail}>{item.detail}</span>
            {item.action === "add_stop" && onAddStop && (
              <button type="button" className={`${styles.button} ${styles.nudge}`} onClick={onAddStop}>Add a stop note for this entry</button>
            )}
          </li>
        ))}
      </ul>
      {note && <p className={styles.planNote}><span className={styles.planNoteLabel}>Plan note: </span>{note}</p>}
    </div>
  );
}
