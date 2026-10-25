import { formatNumber } from "@/lib/desk/format";
import type { PlanItem } from "@/lib/replay/planView";
import styles from "./panels.module.css";

// The plan as live ticks (02o §a3): ✓ met, ! needs attention, • not yet. The mark is decoration; the state is read aloud.

const MARK = { ok: "✓", warn: "!", pending: "•" } as const;
const STATE_WORDS = { ok: "Met", warn: "Needs attention", pending: "Not yet" } as const;

export function PlanChecklist({ items, shares }: { items: PlanItem[]; shares: number }) {
  return (
    <div>
      <ul className={styles.list}>
        <li className={styles.row}>
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.label}>Shares per trade</span>
          <span className={styles.detail}>{formatNumber(shares, 0)}</span>
        </li>
        {items.map((item) => (
          <li key={item.id} className={styles.row}>
            <span className={styles.mark} data-state={item.state} aria-hidden="true">{MARK[item.state]}</span>
            <span className={styles.srOnly}>{STATE_WORDS[item.state]}: </span>
            <span className={styles.label}>{item.label}</span>
            <span className={styles.detail}>{item.detail}</span>
          </li>
        ))}
      </ul>
      {items.length === 0 && <p className={styles.muted}>No plan rules set</p>}
    </div>
  );
}
