"use client";

import { useState } from "react";
import { SwingSetupSection } from "@/components/practice/swing/SwingSetupSection";
import { useUniversePreview } from "@/components/practice/swing/useUniversePreview";
import { ThreadPlanFields } from "@/components/practice/thread/ThreadPlanFields";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { createThread } from "@/lib/desk/replay";
import { effectiveMode, HUB_SWING_COPY, hubSwingText, startBlockedBy, type OpenModes, type ThreadMode } from "@/lib/replay/hubSwing";
import { problemMessage } from "@/lib/replay/setup";
import { defaultSwingDraft, swingProblems, validateSwingDraft, type SwingDraft, type SwingProblems } from "@/lib/replay/swingSetup";
import { defaultThreadDraft, threadProblems, validateThreadDraft, type ThreadDraft } from "@/lib/replay/threadSetup";
import { formatBalance } from "@/lib/replay/threadView";
import { DEFAULT_STARTING_BALANCE } from "@ai-trading/contracts/practice-thread-v1";
import styles from "./hub.module.css";

/** The New thread form (02r): a simulated starting balance, the mode (Day trading or Swing, 02p) and the risk plan that
 *  lives on the thread. Day: "Start thread" validates against the contract and creates the thread. Swing: the Swing
 *  section adds the days, the universe and the swing plan, and "Start swing thread" creates it from the live table.
 *  `open` says which modes have no active thread yet (the server allows one active thread per mode); `wide` gives the form
 *  the whole row (two thread cards sit above it). */
export function NewThreadForm({ open, wide = false, onCreated }: { open: OpenModes; wide?: boolean; onCreated: () => void }) {
  const [draft, setDraft] = useState<ThreadDraft>(defaultThreadDraft);
  const [now] = useState(() => new Date());
  const [swingDraft, setSwingDraft] = useState<SwingDraft>(() => defaultSwingDraft(now));
  const [problems, setProblems] = useState<SwingProblems>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Opening the hub never asks for a universe (the preview starts the data prep): the Swing section opens on her pick.
  const [swingPicked, setSwingPicked] = useState(false);

  // An edit clears the messages of the last try; the live ones (first day, sessions, target) come from the preview.
  const editSwing = (next: SwingDraft) => {
    setSwingDraft(next);
    setProblems({});
  };

  const mode: ThreadMode = effectiveMode(open, draft.mode);
  const waiting = mode === "swing" && !open.day && !swingPicked;
  const swing = mode === "swing" && !waiting;
  const preview = useUniversePreview(swingDraft, swing, now);
  const blocker = swing ? startBlockedBy({ preview: preview.preview, fresh: preview.fresh, problems: preview.problems }) : null;

  async function save() {
    const result = swing ? validateSwingDraft(draft, swingDraft, preview.preview?.rows ?? [], now) : validateThreadDraft({ ...draft, mode: "day" });
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
      if (error instanceof DeskApiError && error.status === 422 && error.problems.length > 0) setProblems(swing ? swingProblems(error.problems) : threadProblems(error.problems));
      else setFailure(problemMessage(error, swing ? PRACTICE_COPY.swingStartThreadError : PRACTICE_COPY.threadStartError));
      setSubmitting(false);
    }
  }

  const typed = Number(draft.startingBalance.replaceAll(",", ""));
  const shownBalance = draft.startingBalance.trim() === "" || !Number.isFinite(typed) ? DEFAULT_STARTING_BALANCE : typed;
  const shownProblems: SwingProblems = swing ? { ...preview.problems, ...problems } : problems;
  const formError = failure ?? shownProblems.form ?? null;
  const modeReason = !open.day ? HUB_SWING_COPY.dayTaken : !open.swing ? HUB_SWING_COPY.swingTaken : null;
  const riskFields = (
    <ThreadPlanFields draft={draft} onDraft={setDraft} problems={shownProblems} idPrefix="new-thread" perWeek={swing} />
  );

  return (
    <form
      aria-label="New thread"
      noValidate
      className={`${styles.form} ${styles.threadPanel} ${swing || wide ? styles.threadPanelWide : ""}`}
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
          <div className={styles.moneyBox} data-invalid={shownProblems.startingBalance ? "true" : undefined}>
            <span aria-hidden="true" className={styles.hint}>$</span>
            <input
              id="thread-balance"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className={styles.moneyInput}
              value={draft.startingBalance}
              aria-invalid={shownProblems.startingBalance ? true : undefined}
              aria-describedby={shownProblems.startingBalance ? "thread-balance-error" : undefined}
              onChange={(event) => setDraft({ ...draft, startingBalance: event.target.value })}
            />
          </div>
          {shownProblems.startingBalance && <p id="thread-balance-error" role="alert" className={styles.fieldError}>{shownProblems.startingBalance}</p>}
        </div>
        <div className={styles.field}>
          <span id="thread-mode-label" className={styles.cap}>{PRACTICE_COPY.threadMode}</span>
          <div role="group" aria-labelledby="thread-mode-label" className={styles.segmented}>
            <button
              type="button"
              className={styles.segment}
              aria-pressed={mode === "day"}
              aria-describedby={modeReason && !open.day ? "thread-mode-reason" : undefined}
              disabled={!open.day}
              onClick={() => setDraft({ ...draft, mode: "day" })}
            >
              {PRACTICE_COPY.threadModeDay}
            </button>
            <button
              type="button"
              className={styles.segment}
              aria-pressed={swing}
              aria-describedby={modeReason && !open.swing ? "thread-mode-reason" : undefined}
              disabled={!open.swing}
              onClick={() => {
                setSwingPicked(true);
                setDraft({ ...draft, mode: "swing" });
              }}
            >
              {PRACTICE_COPY.swingModeLabel}
            </button>
          </div>
          {modeReason && <span id="thread-mode-reason" className={styles.hint}>{modeReason}</span>}
        </div>
      </div>

      {waiting ? (
        <p className={styles.hint}>{HUB_SWING_COPY.pickSwing}</p>
      ) : swing ? (
        <SwingSetupSection draft={swingDraft} onDraft={editSwing} preview={preview} problems={shownProblems} now={now}>
          {riskFields}
        </SwingSetupSection>
      ) : (
        riskFields
      )}

      {!waiting && (
        <div className={styles.inline}>
          <button
            type="submit"
            className={styles.primary}
            disabled={submitting || blocker !== null}
            aria-describedby={swing ? "thread-submit-note" : undefined}
          >
            {swing ? PRACTICE_COPY.swingStartThread : PRACTICE_COPY.threadSubmit}
          </button>
          <p id="thread-submit-note" className={styles.hint}>
            {!swing
              ? practiceText("threadSubmitHint", { balance: formatBalance(shownBalance) })
              : (blocker ?? hubSwingText("startsWith", { balance: formatBalance(shownBalance), n: preview.preview?.rows.length ?? 0 }))}
          </p>
        </div>
      )}
      {formError && <p role="alert" className={styles.fieldError}>{formError}</p>}
    </form>
  );
}
