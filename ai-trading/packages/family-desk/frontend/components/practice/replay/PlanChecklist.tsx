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
}: {
  items: PlanItem[];
  /** `null` leaves the "Shares per trade" row off (a swing session sizes each entry; its own plan rows follow). */
  shares: number | null;
  /** The plan note, if she wrote one. */
  note?: string | null;
}) {
  return (
    <div>
      <ul className={styles.list}>
        {shares !== null && (
          <li className={styles.row}>
            <span className={styles.mark} aria-hidden="true" />
            <span className={styles.label}>Shares per trade</span>
            <span className={styles.detail}>{formatNumber(shares, 0)}</span>
          </li>
        )}
        {items.map((item) => (
          <li key={item.id} className={styles.row} data-state={item.state}>
            <span className={styles.mark} data-state={item.state} aria-hidden="true">{MARK[item.state]}</span>
            <span className="sr-only">{STATE_WORDS[item.state]}: </span>
            <span className={styles.label}>{item.label}</span>
            <span className={styles.detail}>{item.detail}</span>
          </li>
        ))}
      </ul>
      {note && <p className={styles.planNote}><span className={styles.planNoteLabel}>Plan note: </span>{note}</p>}
    </div>
  );
}
