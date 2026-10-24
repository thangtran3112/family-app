import { resolveFreshness, type FreshnessInput } from "@/lib/desk/freshness";
import styles from "./FreshnessBadge.module.css";

/** The one badge for every freshness state (02l §c3). Wording comes from lib/desk/freshness.ts only. */
export function FreshnessBadge(props: FreshnessInput & { className?: string }) {
  const { className, ...input } = props;
  const view = resolveFreshness(input);
  return (
    <span className={`${styles.badge} ${className ?? ""}`} data-state={view.state} data-tone={view.tone} role="status" title={view.label}>
      {view.dot && <span className={styles.dot} aria-hidden="true" />}
      <span className={styles.label}>{view.label}</span>
    </span>
  );
}
