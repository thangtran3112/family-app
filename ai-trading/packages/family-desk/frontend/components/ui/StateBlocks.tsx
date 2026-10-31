import type { ReactNode } from "react";
import { loadErrorText } from "@/lib/desk/freshness";
import styles from "./StateBlocks.module.css";

/** "Loading chart…" skeleton block. */
export function LoadingBlock({ label, height = 160 }: { label: string; height?: number }) {
  return (
    <div className={styles.loading} style={{ minHeight: height }} role="status" aria-live="polite">
      <span className={styles.shimmer} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** "Couldn't load this chart · Try again" (02l §c3), or a custom `message`. Engineering detail never shows here. */
export function ErrorBlock({ subject, message, onRetry }: { subject?: string; message?: string; onRetry: () => void }) {
  // The copy table ends these messages with "· Try again"; the retry button is that last phrase.
  const lead = (message ?? loadErrorText(subject ?? "page")).replace(/ · Try again$/, "");
  return (
    <div className={styles.error} role="alert">
      <span>{lead} ·</span>
      <button type="button" className={styles.button} onClick={onRetry}>Try again</button>
    </div>
  );
}

export function EmptyBlock({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{title}</p>
      {children && <div className={styles.emptyBody}>{children}</div>}
    </div>
  );
}
