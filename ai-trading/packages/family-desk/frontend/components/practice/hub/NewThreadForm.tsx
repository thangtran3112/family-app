"use client";

import { useState } from "react";
import { ThreadPlanFields } from "@/components/practice/thread/ThreadPlanFields";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { createThread } from "@/lib/desk/replay";
import { problemMessage } from "@/lib/replay/setup";
import { defaultThreadDraft, threadProblems, validateThreadDraft, type ThreadDraft, type ThreadProblems } from "@/lib/replay/threadSetup";
import { formatBalance } from "@/lib/replay/threadView";
import { DEFAULT_STARTING_BALANCE } from "@ai-trading/contracts/practice-thread-v1";
import styles from "./hub.module.css";

/** The New thread form (02r): a simulated starting balance, the mode (day trading now, swing later) and the risk plan that
 *  now lives on the thread. "Start thread" validates against the contract and creates the thread. */
export function NewThreadForm({ onCreated }: { onCreated: () => void }) {
  const [draft, setDraft] = useState<ThreadDraft>(defaultThreadDraft);
  const [problems, setProblems] = useState<ThreadProblems>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function save() {
    const result = validateThreadDraft(draft);
    if (!result.ok) {
      setProblems(result.problems);
      return;
    }
    setProblems({});
    setFailure(null);
    setSubmitting(true);
    try {
      await createThread(result.spec);
      onCreated();
    } catch (error) {
      if (error instanceof DeskApiError && error.status === 422 && error.problems.length > 0) setProblems(threadProblems(error.problems));
      else setFailure(problemMessage(error, PRACTICE_COPY.threadStartError));
      setSubmitting(false);
    }
  }

  const typed = Number(draft.startingBalance.replaceAll(",", ""));
  const shownBalance = draft.startingBalance.trim() === "" || !Number.isFinite(typed) ? DEFAULT_STARTING_BALANCE : typed;
  const formError = failure ?? problems.form ?? null;

  return (
    <form
      aria-label="New thread"
      noValidate
      className={`${styles.form} ${styles.threadPanel}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className={styles.sectionHead}>
        <h3 className={styles.threadTitle}>{PRACTICE_COPY.threadNewTitle}</h3>
        <p className={styles.hint}>{PRACTICE_COPY.threadNewHint}</p>
      </div>

      <div className={styles.threadTopRow}>
        <div className={styles.field}>
          <label htmlFor="thread-balance" className={styles.cap}>{PRACTICE_COPY.threadStartingBalance}</label>
          <div className={styles.moneyBox} data-invalid={problems.startingBalance ? "true" : undefined}>
            <span aria-hidden="true" className={styles.hint}>$</span>
            <input
              id="thread-balance"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className={styles.moneyInput}
              value={draft.startingBalance}
              aria-invalid={problems.startingBalance ? true : undefined}
              aria-describedby={problems.startingBalance ? "thread-balance-error" : undefined}
              onChange={(event) => setDraft({ ...draft, startingBalance: event.target.value })}
            />
          </div>
          {problems.startingBalance && <p id="thread-balance-error" role="alert" className={styles.fieldError}>{problems.startingBalance}</p>}
        </div>
        <div className={styles.field}>
          <span id="thread-mode-label" className={styles.cap}>{PRACTICE_COPY.threadMode}</span>
          <div role="group" aria-labelledby="thread-mode-label" className={styles.segmented}>
            <button type="button" className={styles.segment} aria-pressed="true">{PRACTICE_COPY.threadModeDay}</button>
            <button type="button" className={styles.segment} aria-pressed="false" aria-describedby="thread-mode-reason" disabled>
              {PRACTICE_COPY.threadModeSwing}
            </button>
          </div>
          <span id="thread-mode-reason" className={styles.hint}>{PRACTICE_COPY.threadSwingReason}</span>
        </div>
      </div>

      <ThreadPlanFields draft={draft} onDraft={setDraft} problems={problems} idPrefix="new-thread" />

      <div className={styles.inline}>
        <button type="submit" className={styles.primary} disabled={submitting}>{PRACTICE_COPY.threadSubmit}</button>
        <p className={styles.hint}>{practiceText("threadSubmitHint", { balance: formatBalance(shownBalance) })}</p>
      </div>
      {formError && <p role="alert" className={styles.fieldError}>{formError}</p>}
    </form>
  );
}
