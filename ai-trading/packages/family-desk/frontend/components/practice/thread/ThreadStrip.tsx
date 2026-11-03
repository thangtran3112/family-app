import { formatBalance } from "@/lib/replay/threadView";
import type { ThreadBrief } from "@/lib/replay/threads";
import { practiceText } from "@/lib/desk/freshness";
import { SimulatedBadge } from "./SimulatedBadge";
import styles from "./thread.module.css";

/** "Thread balance $50,123  SIMULATED" (the journal is a tab of the strip above). The balance is the ledger's: realized trades only, an open position is not in it
 *  (the clock's equity carries those, D-158). */
export function ThreadStrip({ thread }: { thread: ThreadBrief }) {
  return (
    <div className={styles.strip} role="group" aria-label="Practice thread">
      <span className={styles.stripMain}>
        <span>{practiceText("threadBalanceLine", { balance: formatBalance(thread.balance) })}</span>
        <SimulatedBadge />
      </span>
    </div>
  );
}
