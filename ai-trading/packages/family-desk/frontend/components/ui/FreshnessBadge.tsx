"use client";

import { useDeskFeedStamp } from "@/components/shell/desktop/DeskContext";
import { resolveFreshness, type FreshnessInput, type FreshnessView } from "@/lib/desk/freshness";
import styles from "./FreshnessBadge.module.css";

/** The freshness of a page's data, read against the Desk feed: every badge, dim and stale mark on a screen goes through here, so they cannot disagree. */
export function useFreshness(input: FreshnessInput): FreshnessView {
  const feedStamp = useDeskFeedStamp();
  return resolveFreshness({ ...input, feedStamp: input.feedStamp ?? feedStamp });
}

/** The one badge for every freshness state (02l §c3). Wording comes from lib/desk/freshness.ts only. */
export function FreshnessBadge(props: FreshnessInput & { className?: string }) {
  const { className, ...input } = props;
  const view = useFreshness(input);
  return (
    <span className={`${styles.badge} ${className ?? ""}`} data-state={view.state} data-tone={view.tone} role="status" title={view.label}>
      {view.dot && <span className={styles.dot} aria-hidden="true" />}
      <span className={styles.label}>{view.label}</span>
    </span>
  );
}
