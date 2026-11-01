"use client";

import type { ReactNode } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import styles from "./ConfirmDialog.module.css";

export type ConfirmDialogProps = {
  title: string;
  /** What the action does and whether it can be undone. Every confirm names its consequence. */
  body: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** `danger` for an action that destroys something: the confirm button is red. */
  tone?: "neutral" | "danger";
  /** The action is running: both buttons are off, Escape and the scrim do nothing, and the confirm button shows the label you pass ("Deleting…"). */
  busy?: boolean;
  /** Why the last try failed, plainly. Stays in the dialog so the person can retry or cancel. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A question with two answers, on `Dialog`: the neutral answer comes first and takes the focus, so Enter never confirms by accident.
 * The caller renders it while the question is open and stops rendering it on either answer.
 */
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, tone = "neutral", busy = false, error = null, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Dialog
      title={title}
      size="sm"
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <>
          <Button disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} loading={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      <div className={styles.body}>{body}</div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </Dialog>
  );
}
