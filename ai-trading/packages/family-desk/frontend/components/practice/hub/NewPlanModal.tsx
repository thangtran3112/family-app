"use client";

import { useMemo, useRef, useState } from "react";
import { SwingSetupSection } from "@/components/practice/swing/SwingSetupSection";
import { useUniversePreview } from "@/components/practice/swing/useUniversePreview";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { savePlanPatiently } from "@/lib/desk/patience";
import { createThread, loadDaily, loadUniverseDays, openNextDay } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { hubSwingText, startBlockedBy, type ThreadMode } from "@/lib/replay/hubSwing";
import { defaultPlanDraft, effectiveFirstDay, livePlanProblems, planProblems, startLabel, validatePlanDraft, type PlanDraft, type PlanProblems } from "@/lib/replay/planSetup";
import { latestReplayDay, problemMessage } from "@/lib/replay/setup";
import { defaultSwingDraft, swingProblems, validateSwingDraft, type SwingDraft, type SwingProblems } from "@/lib/replay/swingSetup";
import { defaultThreadDraft, formatBalanceInput, threadProblems, validateThreadDraft, type ThreadDraft, type ThreadProblems } from "@/lib/replay/threadSetup";
import type { PracticeThread } from "@/lib/replay/threads";
import { formatWhole, threadName } from "@/lib/replay/threadView";
import { DEFAULT_STARTING_BALANCE } from "@ai-trading/contracts/practice-thread-v1";
import { DayPlanFields } from "./DayPlanFields";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import styles from "./hub.module.css";
import landing from "./landing.module.css";
import modal from "./newplan.module.css";

type Problems = SwingProblems & PlanProblems & ThreadProblems;
/** Where a failed submit stopped: starting the thread or saving its plan. */
type Stage = "thread" | "plan";

/**
 * The New plan modal (02r2, Paper mock X9Y-0; redesigned in fix wave 5S, D-075 and D-076): a modal around three things, the
 * filter picker, the day and window settings, and one button that starts the practice. The pretend balance and the mode sit
 * on top. "Start 20-day practice" starts the thread, saves the plan, which starts preparing the data and opens Day 1, then
 * `onSaved` takes her to the thread page. Swing (02p) swaps the daily fields for its universe and calendar and starts the
 * thread from the live universe table. The risk plan and the armed strategies are not asked here (D-076): the thread takes
 * the server's defaults, and its risk plan is edited in the journal.
 *
 * It is a `ui/Dialog`, which owns the scrim, the focus trap, Escape and the focus handed back to the button that opened it.
 *
 * Any number of threads of either mode may be active, so Day and Swing are always offered. With `thread` set the modal only
 * replaces that day thread's plan: its balance and risk plan stay with it. The settings are checked as she edits, and a
 * form she has edited asks before it is thrown away (M-05). Nothing here reaches IBKR.
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
  const closeRef = useRef<HTMLButtonElement>(null);
  const [now] = useState(() => new Date());
  const [threadDraft, setThreadDraft] = useState<ThreadDraft>(() => {
    const fresh = defaultThreadDraft();
    return { ...fresh, startingBalance: formatBalanceInput(fresh.startingBalance) }; // "50,000" from the first look (M-07)
  });
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
  const [swingDayPicked, setSwingDayPicked] = useState(false);
  const recordedDay = recorded.data?.first_day_default ?? null;
  const firstDay = effectiveFirstDay(plan.firstDay, dayPicked, recordedDay);
  // A swing thread starts on the same recorded morning (M-04): the guess three months back can lie outside the data.
  const swingFirstDay = effectiveFirstDay(swingDraft.firstDay, swingDayPicked, recordedDay);
  const swingNow = useMemo<SwingDraft>(() => (swingFirstDay === swingDraft.firstDay ? swingDraft : { ...swingDraft, firstDay: swingFirstDay }), [swingDraft, swingFirstDay]);
  // The form as it opened: anything else is an edit, and closing it asks first.
  const snapshot = JSON.stringify({ threadDraft, plan, swingDraft, dayPicked, swingDayPicked });
  const [pristine] = useState(snapshot);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const planOnly = thread !== null;
  const mode: ThreadMode = planOnly ? "day" : threadDraft.mode;
  const swing = mode === "swing";
  const preview = useUniversePreview(swingNow, swing, now);
  const blocker = swing ? startBlockedBy({ preview: preview.preview, fresh: preview.fresh, problems: preview.problems }) : null;
  const noFilters = !swing && plan.filterIds.length === 0;

  // Escape, Close and a click on the dimmed page all ask first once the form has been edited (M-05).
  const requestClose = () => {
    if (submitting) return;
    if (snapshot !== pristine) setConfirmingDiscard(true);
    else onClose();
  };

  // An edit clears the messages of the last try; the live ones (first day, days, balance, the swing universe) are read from the draft.
  const editThread = (next: ThreadDraft) => {
    setThreadDraft(next);
    setProblems({});
  };
  const editPlan = (next: PlanDraft) => {
    setPlan(next);
    setProblems({});
  };
  const editSwing = (next: SwingDraft) => {
    if (next.firstDay !== swingFirstDay) setSwingDayPicked(true);
    setSwingDraft(next);
    setProblems({});
  };

  async function submit() {
    const day = swing ? null : validatePlanDraft({ ...plan, firstDay }, now);
    const started = planOnly || swing ? null : validateThreadDraft({ ...threadDraft, mode: "day" });
    const swingResult = swing ? validateSwingDraft(threadDraft, swingNow, preview.preview?.rows ?? [], now) : null;
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
  // What is wrong, as she edits (the draft read now) with what the last try or the server said on top.
  const liveThread: ThreadProblems = (() => {
    if (planOnly) return {};
    const result = validateThreadDraft({ ...threadDraft, mode: "day" });
    return result.ok ? {} : result.problems;
  })();
  const live: Problems = { ...liveThread, ...(swing ? preview.problems : livePlanProblems({ ...plan, firstDay }, now)) };
  const shown: Problems = { ...live, ...problems };
  const { form: formProblem, ...fieldProblems } = shown;
  const formError = failure ?? formProblem ?? null;
  const echo = Object.values(fieldProblems).find((text) => text) ?? null;
  // Why Start is off, in the footer: a problem first, then what is still missing. null means it can start.
  const held = echo ?? (swing ? blocker : noFilters ? PRACTICE_COPY.planSaveFilterFirst : null);
  const note = swing
    ? hubSwingText("startsWith", { balance: formatWhole(shownBalance), n: preview.preview?.rows.length ?? 0 })
    : planOnly
      ? PRACTICE_COPY.threadPlanFrom
      : practiceText("threadSubmitHint", { balance: formatWhole(shownBalance) });
  const status = confirmingDiscard ? PRACTICE_COPY.newPlanDiscardTitle : still ? PRACTICE_COPY.planStillWorking : (held ?? note);

  return (
    <Dialog
      title={planOnly ? practiceText("landingNewPlanFor", { name: threadName(thread) }) : PRACTICE_COPY.newPlanTitle}
      size="lg"
      // Escape on the question keeps the form; anywhere else it asks first once the form has been edited.
      onClose={() => (confirmingDiscard ? setConfirmingDiscard(false) : requestClose())}
      headerActions={<button ref={closeRef} type="button" className={styles.button} disabled={submitting} onClick={requestClose}>{PRACTICE_COPY.newPlanClose}</button>}
      onSubmit={(event) => {
        event.preventDefault();
        if (held === null && !submitting && !confirmingDiscard) void submit();
      }}
      footer={
        <>
          <p id="new-plan-note" role="status" className={modal.status}>{status}</p>
          {confirmingDiscard ? (
            <div className={modal.discard}>
              <button
                type="button"
                className={styles.button}
                autoFocus
                onClick={() => {
                  setConfirmingDiscard(false);
                  closeRef.current?.focus();
                }}
              >
                {PRACTICE_COPY.newPlanDiscardKeep}
              </button>
              <button type="button" className={styles.button} onClick={onClose}>{PRACTICE_COPY.newPlanDiscard}</button>
            </div>
          ) : (
            <button
              type="submit"
              className={`${styles.primary} ${modal.submit}`}
              aria-disabled={held !== null || submitting || undefined}
              aria-busy={submitting || undefined}
              aria-describedby="new-plan-note"
            >
              {submitting && <span className={landing.spinner} aria-hidden="true" />}
              {submitting ? PRACTICE_COPY.newPlanSubmitting : startLabel(swing ? swingNow.sessions : plan.sessions, swing)}
            </button>
          )}
        </>
      }
    >
      <p className={modal.help}>{planOnly ? PRACTICE_COPY.newPlanIntroPlan : swing ? PRACTICE_COPY.newPlanSwingNote : PRACTICE_COPY.newPlanIntroThread}</p>
      <p className={modal.help}>{PRACTICE_COPY.newPlanFooter}</p>

      {!planOnly && (
        <div className={modal.topRow}>
          <Field
            id="new-plan-balance"
            label={PRACTICE_COPY.threadStartingBalance}
            aside={<SimulatedBadge />}
            note={PRACTICE_COPY.threadBalanceHint}
            error={shown.startingBalance}
            reserve
          >
            <Input
              adornment="$"
              inputMode="numeric"
              autoComplete="off"
              value={threadDraft.startingBalance}
              onChange={(event) => editThread({ ...threadDraft, startingBalance: event.target.value })}
              onBlur={() => editThread({ ...threadDraft, startingBalance: formatBalanceInput(threadDraft.startingBalance) })}
            />
          </Field>
          <Field id="new-plan-mode" label={PRACTICE_COPY.threadMode} group>
            <Segmented
              value={mode}
              options={[{ value: "day", label: PRACTICE_COPY.threadModeDay }, { value: "swing", label: PRACTICE_COPY.swingModeLabel }]}
              onChange={(next) => editThread({ ...threadDraft, mode: next })}
            />
          </Field>
        </div>
      )}

      {swing ? (
        <SwingSetupSection draft={swingNow} onDraft={editSwing} preview={preview} problems={shown} now={now} />
      ) : (
        <DayPlanFields
          draft={plan}
          onDraft={editPlan}
          problems={shown}
          firstDay={firstDay}
          firstDayNote={recorded.data?.first_day_note ?? null}
          maxDay={latestReplayDay(now)}
          onFirstDay={(day) => {
            setDayPicked(true);
            editPlan({ ...plan, firstDay: day });
          }}
        />
      )}

      {formError && <p role="alert" className={modal.fieldError}>{formError}</p>}
      {startedId !== null && failure !== null && <p className={modal.help}>{PRACTICE_COPY.newPlanThreadKept}</p>}
    </Dialog>
  );
}
