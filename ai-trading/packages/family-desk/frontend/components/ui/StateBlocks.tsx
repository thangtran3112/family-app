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

/** "Couldn't load this chart · Try again" (02l §c3). Engineering detail never shows here. */
export function ErrorBlock({ subject, onRetry }: { subject: string; onRetry: () => void }) {
  return (
    <div className={styles.error} role="alert">
      <span>{loadErrorText(subject)}</span>
      <button type="button" className={styles.button} onClick={onRetry}>Try again</button>
    </div>
  );
}

export function EmptyBlock({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{title}</p>
      {children && <div className={styles.emptyBody}>{children}</div>}
    </div>
  );
}
