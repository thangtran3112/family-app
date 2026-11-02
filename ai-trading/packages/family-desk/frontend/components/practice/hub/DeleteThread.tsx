"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { deleteThread } from "@/lib/desk/replay";
import { problemMessage } from "@/lib/replay/setup";
import type { PracticeThread } from "@/lib/replay/threads";
import { threadName } from "@/lib/replay/threadView";
import styles from "./landing.module.css";

/**
 * The Delete button of a thread row and its confirmation. Deleting removes the thread with its days and SIMULATED
 * history and cannot be undone, so it asks first. An open practice day is the server's plain 409, shown in the dialog.
 * `busy` is the table's shared flag (some row is opening a day): nothing can be deleted meanwhile. The question is a
 * `ui/ConfirmDialog`; it sits inside the row, and stops its clicks there, so they never reach the row's click that opens the thread page.
 * `plan` is the same delete on the thread's Summary, worded for the plan ("Delete plan"): a plan is its thread, it is never edited, and a
 * new plan is a new thread. There it stands alone, so it needs neither the table's flag nor a row name in its label.
 */
export function DeleteThread({
  thread,
  busy = false,
  onBusy = () => undefined,
  onDeleted,
  plan = false,
}: {
  thread: PracticeThread;
  busy?: boolean;
  onBusy?: (busy: boolean) => void;
  onDeleted: (name: string) => void;
  plan?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const close = () => {
    if (deleting) return;
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
      <Button
        className={styles.deleteButton}
        disabled={busy}
        aria-label={plan ? undefined : `${PRACTICE_COPY.threadDelete} ${threadName(thread)}`}
        onClick={() => setAsking(true)}
      >
        {plan ? PRACTICE_COPY.planDelete : PRACTICE_COPY.threadDelete}
      </Button>
      {asking && (
        <ConfirmDialog
          title={practiceText("threadDeleteTitleNamed", { name: threadName(thread) })}
          body={plan ? PRACTICE_COPY.planDeleteBody : PRACTICE_COPY.threadDeleteBody}
          confirmLabel={deleting ? PRACTICE_COPY.threadDeleting : plan ? PRACTICE_COPY.planDeleteConfirm : PRACTICE_COPY.threadDeleteConfirm}
          cancelLabel={PRACTICE_COPY.threadDeleteKeep}
          tone="danger"
          busy={deleting}
          error={message}
          onConfirm={() => void confirm()}
          onCancel={close}
        />
      )}
    </>
  );
}
