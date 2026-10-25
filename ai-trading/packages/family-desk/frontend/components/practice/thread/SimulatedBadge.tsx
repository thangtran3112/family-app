import { PRACTICE_COPY } from "@/lib/desk/freshness";
import styles from "./thread.module.css";

/** The amber SIMULATED mini-badge beside every pretend dollar figure (02r): the money here is never real. */
export function SimulatedBadge() {
  return <span className={styles.simulated}>{PRACTICE_COPY.threadSimulated}</span>;
}
