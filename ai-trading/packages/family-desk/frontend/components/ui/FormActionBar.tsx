"use client";

import type { ReactNode } from "react";
import { useUnsavedGuard } from "@/components/shell/desktop/useUnsavedGuard";
import { formBarStatus } from "@/lib/desk/primitivesView";
import styles from "./FormActionBar.module.css";

/**
 * The one save bar of a form: the status on the left, the `secondary` then the `primary` action on the right (both `<Button>`s,
 * so their heights match). It sticks to the bottom of the scroll container, in flow. Passing `dirty` also reports it to the
 * shell's navigation guard and the browser's leave prompt, so a form never keeps its own copy of that logic.
 * `status` replaces the default "You have unsaved changes" (and shows with no `dirty`); a screen that needs both a title and a
 * note passes them as children of `status`.
 */
export function FormActionBar({ primary, secondary, status, dirty, label = "Form actions", className }: {
  primary: ReactNode;
  secondary?: ReactNode;
  status?: ReactNode;
  /** Omit when the form guards itself (or has nothing to lose); `false` means clean and still guards. */
  dirty?: boolean;
  /** The bar's accessible name; the screener's is "Unsaved changes". */
  label?: string;
  /** Layout only (margin, width, grid-area). */
  className?: string;
}) {
  useUnsavedGuard(dirty);
  const text = formBarStatus({ dirty, status });
  return (
    <div role="region" aria-label={label} className={`${styles.bar} ${className ?? ""}`}>
      {text !== null && <div className={styles.status}>{typeof text === "string" ? <p>{text}</p> : text}</div>}
      <div className={styles.actions}>
        {secondary}
        {primary}
      </div>
    </div>
  );
}
