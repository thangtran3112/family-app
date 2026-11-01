"use client";

import { useEffect, useRef, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Button } from "./Button";
import styles from "./InlineConfirm.module.css";

export type InlineConfirmProps = {
  /** The group's accessible name: "Confirm ending the day". */
  label: string;
  /** The question, and what it costs. For more than one line, pass each line as its own element. */
  prompt?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** `danger` for an action that destroys something: a red confirm button, and focus starts on the cancel button. */
  tone?: "neutral" | "danger";
  /** The action is running: both buttons are off, Escape and blur do not close it, and the confirm button shows the label you pass ("Deleting…"). */
  busy?: boolean;
  size?: "sm" | "md" | "lg";
  /** inline = a row in a toolbar, block = a bordered panel, floating = a block that opens over the page. */
  layout?: "inline" | "block" | "floating";
  /** Layout only: where a floating confirm sits (position, width). */
  className?: string;
  /** The trigger, as a ref or (one trigger per row) a function that finds it. Escape and the cancel button hand focus back to it after `onCancel`, so it may be a trigger the confirm replaced. */
  returnFocus: RefObject<HTMLElement | null> | (() => HTMLElement | null);
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * The second step of a two-step action, in place of a dialog: the trigger sets `open`, the caller renders this while it is open
 * and stops rendering it on either answer. It takes focus when it opens (the confirm button, or the cancel button for a `danger`
 * one), Escape or the cancel button close it and put focus back on the trigger, and focus moving to anything outside it cancels
 * it without taking focus back. The neutral answer comes first.
 */
export function InlineConfirm({ label, prompt, confirmLabel, cancelLabel, tone = "neutral", busy = false, size, layout = "inline", className, returnFocus, onConfirm, onCancel }: InlineConfirmProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    (tone === "danger" ? cancelRef : confirmRef).current?.focus({ preventScroll: true });
  }, [tone]);

  const back = () => {
    onCancel();
    requestAnimationFrame(() => (typeof returnFocus === "function" ? returnFocus() : returnFocus.current)?.focus({ preventScroll: true }));
  };

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    // A screen with its own key map on the document (the replay) must not also act on this Escape.
    event.nativeEvent.stopImmediatePropagation();
    if (!busy) back();
  }

  // Focus went to another control or a click elsewhere: drop the question. Not while the answer runs, and not when the window
  // itself lost focus (switching tabs must not cancel it).
  function onBlur(event: FocusEvent<HTMLElement>) {
    if (busy || !document.hasFocus() || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    onCancel();
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={`${styles.root} ${className ?? ""}`}
      data-layout={layout}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      // A press on one of its buttons must not move focus first (Safari does not focus a pressed button), or the blur would cancel before the click lands.
      onMouseDown={(event) => event.preventDefault()}
    >
      {prompt && <div className={styles.prompt}>{prompt}</div>}
      <div className={styles.actions}>
        <Button ref={cancelRef} size={size} disabled={busy} onClick={back}>{cancelLabel}</Button>
        <Button ref={confirmRef} size={size} variant={tone === "danger" ? "danger" : "primary"} loading={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </div>
  );
}
