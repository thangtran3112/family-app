import Link from "next/link";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import styles from "./landing.module.css";

/** "← Back to practice" at the top-left of a trading screen (day list, swing board, replay workspace): to the thread's page
 *  when the screen knows the thread, else the Practice landing. Leaves the screen's own controls alone. */
export function BackLink({ threadId }: { threadId: number | null }) {
  return (
    <div className={styles.backBar}>
      <Link href={threadId === null ? "/practice" : `/practice/thread?id=${threadId}`} className={styles.back}>{`← ${PRACTICE_COPY.backToPractice}`}</Link>
    </div>
  );
}
