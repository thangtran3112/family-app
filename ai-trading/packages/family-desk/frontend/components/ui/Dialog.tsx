"use client";

import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import styles from "./Dialog.module.css";

export type DialogProps = {
  /** The visible heading, and the dialog's accessible name. */
  title: string;
  /**
   * Escape, a press on the dimmed page, or a Close control asked to close. The caller decides (it may ask first): the dialog stays
   * open until its owner stops rendering it.
   */
  onClose: () => void;
  /** sm 420 px (a confirm), md 520 px (default), lg 720 px (a form). */
  size?: "sm" | "md" | "lg";
  /** Controls at the right of the heading (a Close button). */
  headerActions?: ReactNode;
  /** The bottom bar, right-aligned: put the neutral action first and the main one last. */
  footer?: ReactNode;
  /** Makes head, body and foot one `<form>` (`noValidate`), so a submit button in the footer submits. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
};

const TABBABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
const tabbables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((element) => element.getClientRects().length > 0);

// Nested or stacked dialogs share one lock: the page scrolls again when the last one closes.
let scrollLocks = 0;
function lockScroll(): () => void {
  if (scrollLocks++ === 0) document.documentElement.style.overflow = "hidden";
  return () => {
    if (--scrollLocks === 0) document.documentElement.style.overflow = "";
  };
}

/**
 * The one modal. Render it to open it, stop rendering it to close it. A native `<dialog>` opened with `showModal()`: it sits in
 * the top layer (so there is no portal and no stacking to manage), the page behind it is inert, and its scrim is `--color-scrim`.
 * On top of that it owns: Tab held inside the dialog, Escape and a press on the scrim both calling `onClose`, the page's scroll
 * locked, focus put on the first control when it opens, and focus handed back to the control that opened it when it closes.
 * Clicks and Escape stop at the dialog, so a dialog rendered inside a clickable row never triggers the row.
 */
export function Dialog({ title, onClose, size = "md", headerActions, footer, onSubmit, children }: DialogProps) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  // The control that had focus when the dialog opened. A ref, so a dev-mode double effect does not mistake the dialog's own control for it.
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  const pressedScrim = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (opener.current === undefined) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    // The first control, not the browser's pick: a scrolling body can be a focus stop of its own.
    (tabbables(dialog)[0] ?? dialog).focus({ preventScroll: true });
    const unlock = lockScroll();
    return () => {
      unlock();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      // A screen with its own key map on the document (the replay) must not also act on this Escape.
      event.nativeEvent.stopImmediatePropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = tabbables(event.currentTarget);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) {
      event.preventDefault();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const parts = (
    <>
      <header className={styles.head}>
        <h2 id={titleId} className={styles.title}>{title}</h2>
        {headerActions}
      </header>
      <div className={styles.body}>{children}</div>
      {footer && <footer className={styles.foot}>{footer}</footer>}
    </>
  );

  return (
    <dialog
      ref={ref}
      className={styles.root}
      data-size={size}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      // Escape that reaches the browser (focus outside the dialog's controls) arrives as `cancel`; the caller decides what it means.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event: MouseEvent<HTMLDialogElement>) => {
        pressedScrim.current = event.target === event.currentTarget;
      }}
      onClick={(event: MouseEvent<HTMLDialogElement>) => {
        event.stopPropagation();
        // The scrim is the dialog element itself (the frame fills the rest); a drag that began inside the panel is not a press on it.
        if (event.target === event.currentTarget && pressedScrim.current) onClose();
      }}
    >
      {onSubmit ? (
        <form noValidate className={styles.frame} onSubmit={onSubmit}>{parts}</form>
      ) : (
        <div className={styles.frame}>{parts}</div>
      )}
    </dialog>
  );
}
