"use client";

import { useEffect, useRef, useState } from "react";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { deleteThread } from "@/lib/desk/replay";
import { problemMessage } from "@/lib/replay/setup";
import type { PracticeThread } from "@/lib/replay/threads";
import { threadName } from "@/lib/replay/threadView";
import hub from "./hub.module.css";
import styles from "./landing.module.css";

/**
 * The Delete button of a thread row and its confirmation. Deleting removes the thread with its days and SIMULATED
 * history and cannot be undone, so it asks first. An open practice day is the server's plain 409, shown in the dialog.
 * `busy` is the table's shared flag (some row is opening a day): nothing can be deleted meanwhile. The dialog sits inside
 * the row, so its clicks must not reach the row's click that opens the thread page.
 */
export function DeleteThread({
  thread,
  busy,
  onBusy,
  onDeleted,
}: {
  thread: PracticeThread;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onDeleted: (name: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // A native modal dialog: the browser holds focus inside it, dims the page and sends Escape as `cancel`.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!asking || !dialog) return;
    if (!dialog.open) dialog.showModal();
  }, [asking]);

  const close = () => {
    if (deleting) return;
    dialogRef.current?.close();
    setAsking(false);
    setMessage(null);
  };

  async function confirm() {
    setDeleting(true);
    setMessage(null);
    onBusy(true);
    try {
      await deleteThread(thread.id);
      onBusy(false);
      onDeleted(threadName(thread));
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.threadDeleteError));
      setDeleting(false);
      onBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`${hub.button} ${styles.deleteButton}`}
        disabled={busy}
        aria-label={`${PRACTICE_COPY.threadDelete} ${threadName(thread)}`}
        onClick={() => setAsking(true)}
      >
        {PRACTICE_COPY.threadDelete}
      </button>
      {asking && (
        <dialog
          ref={dialogRef}
          className={`${styles.dialog} ${styles.confirmDialog}`}
          aria-labelledby={`delete-thread-${thread.id}-title`}
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) close();
          }}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <div className={styles.dialogForm}>
            <div className={styles.dialogBody}>
              <h2 id={`delete-thread-${thread.id}-title`} className={styles.dialogTitle}>{practiceText("threadDeleteTitleNamed", { name: threadName(thread) })}</h2>
              <p className={hub.muted}>{PRACTICE_COPY.threadDeleteBody}</p>
              {message && <p role="alert" className={hub.fieldError}>{message}</p>}
            </div>
            <footer className={styles.dialogFoot}>
              <button type="button" className={hub.button} disabled={deleting} onClick={close}>{PRACTICE_COPY.threadDeleteKeep}</button>
              <button type="button" className={`${hub.button} ${styles.deleteButton}`} disabled={deleting} aria-busy={deleting || undefined} onClick={() => void confirm()}>
                {deleting ? PRACTICE_COPY.threadDeleting : PRACTICE_COPY.threadDeleteConfirm}
              </button>
            </footer>
          </div>
        </dialog>
      )}
    </>
  );
}
