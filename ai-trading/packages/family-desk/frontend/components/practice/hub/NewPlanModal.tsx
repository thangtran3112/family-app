"use client";

import { useEffect, useRef, useState } from "react";
import { SwingSetupSection } from "@/components/practice/swing/SwingSetupSection";
import { useUniversePreview } from "@/components/practice/swing/useUniversePreview";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { ThreadPlanFields } from "@/components/practice/thread/ThreadPlanFields";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { savePlanPatiently } from "@/lib/desk/patience";
import { createThread, loadDaily, loadUniverseDays, openNextDay } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { hubSwingText, startBlockedBy, type ThreadMode } from "@/lib/replay/hubSwing";
import { defaultPlanDraft, effectiveFirstDay, planProblems, validatePlanDraft, type PlanDraft, type PlanProblems } from "@/lib/replay/planSetup";
import { problemMessage } from "@/lib/replay/setup";
import { defaultSwingDraft, swingProblems, validateSwingDraft, type SwingDraft, type SwingProblems } from "@/lib/replay/swingSetup";
import { MAX_STARTING_BALANCE, MIN_STARTING_BALANCE, defaultThreadDraft, threadProblems, validateThreadDraft, type ThreadDraft } from "@/lib/replay/threadSetup";
import type { PracticeThread } from "@/lib/replay/threads";
import { formatWhole, threadName } from "@/lib/replay/threadView";
import { DEFAULT_STARTING_BALANCE } from "@ai-trading/contracts/practice-thread-v1";
import { DayPlanFields } from "./DayPlanFields";
import styles from "./hub.module.css";
import landing from "./landing.module.css";
import modal from "./newplan.module.css";

type Problems = SwingProblems & PlanProblems;
/** Where a failed submit stopped: starting the thread or saving its plan. */
type Stage = "thread" | "plan";

/**
 * The New plan modal (02r2, Paper mock X9Y-0): one form for the thread (a simulated starting balance and its risk plan)
 * and the daily plan (filters, days, list time, window, armed strategies). "Populate data" starts the thread, saves the
 * plan, which starts preparing the data and opens Day 1, then `onSaved` takes her to the thread page. Swing (02p) swaps the daily
 * fields for its universe and calendar and starts the thread from the live universe table.
 *
 * Any number of threads of either mode may be active, so Day and Swing are always offered. With `thread` set the modal only
 * replaces that day thread's plan: its balance and risk plan stay with it. Nothing here reaches IBKR.
 */
export function NewPlanModal({
  thread = null,
  onClose,
  onSaved,
}: {
  thread?: PracticeThread | null;
  onClose: () => void;
  /** The thread and its plan are saved; the page decides where to go next. */
  onSaved: (threadId: number) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [now] = useState(() => new Date());
  const [threadDraft, setThreadDraft] = useState<ThreadDraft>(defaultThreadDraft);
  const [plan, setPlan] = useState<PlanDraft>(() => defaultPlanDraft(now));
  const [swingDraft, setSwingDraft] = useState<SwingDraft>(() => defaultSwingDraft(now));
  const [problems, setProblems] = useState<Problems>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Set while the gateway has cut a slow save short and the screen is waiting for the plan to show up (D-058).
  const [still, setStill] = useState(false);
  // The thread started by an earlier try whose plan did not save: a retry continues with it instead of starting another.
  const [startedId, setStartedId] = useState<number | null>(null);
  // Once the Desk has recorded 20 finished days of its universe, a new plan starts on the first one (02o-b2) unless she has picked a day.
  const recorded = useDeskQuery("practice:universe-days", (signal) => loadUniverseDays({}, { signal }));
  const [dayPicked, setDayPicked] = useState(false);
  const firstDay = effectiveFirstDay(plan.firstDay, dayPicked, recorded.data?.first_day_default ?? null);

  const planOnly = thread !== null;
  const mode: ThreadMode = planOnly ? "day" : threadDraft.mode;
  const swing = mode === "swing";
  const preview = useUniversePreview(swingDraft, swing, now);
  const blocker = swing ? startBlockedBy({ preview: preview.preview, fresh: preview.fresh, problems: preview.problems }) : null;
  const noFilters = !swing && plan.filterIds.length === 0;

  // A native modal dialog: the browser holds focus inside it, dims and disables the page behind it, and sends Escape as `cancel`.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => previous?.focus();
  }, []);

  // An edit clears the messages of the last try; the live swing ones (first day, sessions, target) come from the preview.
  const editSwing = (next: SwingDraft) => {
    setSwingDraft(next);
    setProblems({});
  };

  async function submit() {
    const day = swing ? null : validatePlanDraft({ ...plan, firstDay });
    const started = planOnly || swing ? null : validateThreadDraft({ ...threadDraft, mode: "day" });
    const swingResult = swing ? validateSwingDraft(threadDraft, swingDraft, preview.preview?.rows ?? [], now) : null;
    const found: Problems = {
      ...(day && !day.ok ? day.problems : {}),
      ...(started && !started.ok ? started.problems : {}),
      ...(swingResult && !swingResult.ok ? swingResult.problems : {}),
    };
    if (Object.keys(found).length > 0) {
      setProblems(found);
      return;
    }
    setProblems({});
    setFailure(null);
    setStill(false);
    setSubmitting(true);
    let stage: Stage = "thread";
    try {
      if (swingResult?.ok) {
        const created = await createThread(swingResult.spec);
        onSaved(created.thread.id);
        return;
      }
      if (!day?.ok) return;
      let threadId = thread?.id ?? startedId;
      if (threadId === null && started?.ok) {
        threadId = (await createThread(started.spec)).thread.id;
        setStartedId(threadId);
      }
      if (threadId === null) return;
      stage = "plan";
      const id = threadId;
      const before = await loadDaily({ threadId: id }).then((daily) => daily.plan?.id ?? null, () => null);
      await savePlanPatiently(
        () => openNextDay(day.spec, { threadId: id }),
        () => openNextDay(undefined, { threadId: id }),
        () => loadDaily({ threadId: id }).then((daily) => daily.plan?.id ?? null),
        before,
        { onWaiting: () => setStill(true) },
      );
      onSaved(id);
    } catch (error) {
      if (error instanceof DeskApiError && error.status === 422 && error.problems.length > 0) {
        setProblems(stage === "thread" ? (swing ? swingProblems(error.problems) : threadProblems(error.problems)) : planProblems(error.problems));
      } else {
        setFailure(problemMessage(error, swing ? PRACTICE_COPY.swingStartThreadError : stage === "thread" ? PRACTICE_COPY.threadStartError : PRACTICE_COPY.newPlanError));
      }
      setStill(false);
      setSubmitting(false);
    }
  }

  const typed = Number(threadDraft.startingBalance.replaceAll(",", ""));
  const shownBalance = threadDraft.startingBalance.trim() === "" || !Number.isFinite(typed) ? DEFAULT_STARTING_BALANCE : typed;
  const shown: Problems = swing ? { ...preview.problems, ...problems } : problems;
  const formError = failure ?? shown.form ?? null;
  const riskFields = <ThreadPlanFields draft={threadDraft} onDraft={setThreadDraft} problems={shown} idPrefix="new-plan" perWeek={swing} />;
  const note = swing
    ? (blocker ?? hubSwingText("startsWith", { balance: formatWhole(shownBalance), n: preview.preview?.rows.length ?? 0 }))
    : noFilters
      ? PRACTICE_COPY.planSaveFilterFirst
      : planOnly
        ? PRACTICE_COPY.threadPlanFrom
        : practiceText("threadSubmitHint", { balance: formatWhole(shownBalance) });

  return (
    <dialog
      ref={dialogRef}
      className={modal.dialog}
      aria-labelledby="new-plan-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <form
        noValidate
        aria-label={PRACTICE_COPY.newPlanTitle}
        className={modal.dialogForm}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header className={modal.dialogHead}>
          <h2 id="new-plan-title" className={modal.dialogTitle}>{planOnly ? practiceText("landingNewPlanFor", { name: threadName(thread) }) : PRACTICE_COPY.newPlanTitle}</h2>
          <button type="button" className={styles.button} disabled={submitting} onClick={onClose}>{PRACTICE_COPY.newPlanClose}</button>
        </header>

        <div className={modal.dialogBody}>
          <p className={styles.muted}>{planOnly ? PRACTICE_COPY.newPlanIntroPlan : swing ? PRACTICE_COPY.newPlanSwingNote : PRACTICE_COPY.newPlanIntroThread}</p>

          {!planOnly && (
            <div className={styles.threadTopRow}>
              <div className={styles.field}>
                <label htmlFor="new-plan-balance" className={styles.cap}>{PRACTICE_COPY.threadStartingBalance}</label>
                <div className={styles.moneyBox} data-invalid={shown.startingBalance ? "true" : undefined}>
                  <span aria-hidden="true" className={styles.hint}>$</span>
                  <input
                    id="new-plan-balance"
                    type="number"
                    inputMode="numeric"
                    min={MIN_STARTING_BALANCE}
                    max={MAX_STARTING_BALANCE}
                    step={1}
                    autoComplete="off"
                    className={styles.moneyInput}
                    value={threadDraft.startingBalance}
                    aria-invalid={shown.startingBalance ? true : undefined}
                    aria-describedby={shown.startingBalance ? "new-plan-balance-error" : undefined}
                    onChange={(event) => setThreadDraft({ ...threadDraft, startingBalance: event.target.value })}
                  />
                  <SimulatedBadge />
                </div>
                {shown.startingBalance && <p id="new-plan-balance-error" role="alert" className={styles.fieldError}>{shown.startingBalance}</p>}
              </div>
              <div className={styles.field}>
                <span id="new-plan-mode-label" className={styles.cap}>{PRACTICE_COPY.threadMode}</span>
                <div role="group" aria-labelledby="new-plan-mode-label" className={styles.segmented}>
                  <button
                    type="button"
                    className={styles.segment}
                    aria-pressed={mode === "day"}
                    onClick={() => setThreadDraft({ ...threadDraft, mode: "day" })}
                  >
                    {PRACTICE_COPY.threadModeDay}
                  </button>
                  <button
                    type="button"
                    className={styles.segment}
                    aria-pressed={swing}
                    onClick={() => setThreadDraft({ ...threadDraft, mode: "swing" })}
                  >
                    {PRACTICE_COPY.swingModeLabel}
                  </button>
                </div>
              </div>
            </div>
          )}

          {swing ? (
            <SwingSetupSection draft={swingDraft} onDraft={editSwing} preview={preview} problems={shown} now={now}>
              {riskFields}
            </SwingSetupSection>
          ) : (
            <>
              <DayPlanFields
                draft={plan}
                onDraft={setPlan}
                problems={shown}
                firstDay={firstDay}
                firstDayNote={recorded.data?.first_day_note ?? null}
                onFirstDay={(day) => {
                  setDayPicked(true);
                  setPlan({ ...plan, firstDay: day });
                }}
              />
              {!planOnly && (
                <fieldset className={styles.group}>
                  <legend className={styles.legend}>{PRACTICE_COPY.newPlanRiskTitle}</legend>
                  <p className={styles.hint}>{PRACTICE_COPY.threadNewHint}</p>
                  {riskFields}
                </fieldset>
              )}
            </>
          )}

          {still && <p role="status" className={styles.hint}>{PRACTICE_COPY.planStillWorking}</p>}
          {formError && <p role="alert" className={styles.fieldError}>{formError}</p>}
          {startedId !== null && failure !== null && <p className={styles.hint}>{PRACTICE_COPY.newPlanThreadKept}</p>}
        </div>

        <footer className={modal.dialogFoot}>
          <div className={modal.footNotes}>
            <p id="new-plan-note" className={styles.hint}>{note}</p>
            <p className={styles.hint}>{PRACTICE_COPY.newPlanFooter}</p>
          </div>
          <button
            type="submit"
            className={`${styles.primary} ${modal.submit}`}
            disabled={submitting || noFilters || blocker !== null}
            aria-busy={submitting || undefined}
            aria-describedby="new-plan-note"
          >
            {submitting && <span className={landing.spinner} aria-hidden="true" />}
            {swing ? (submitting ? PRACTICE_COPY.planSubmitting : PRACTICE_COPY.swingStartThread) : submitting ? PRACTICE_COPY.newPlanSubmitting : PRACTICE_COPY.newPlanSubmit}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
