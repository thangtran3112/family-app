"use client";

import { useEffect, useRef, useState } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { savePlanPatiently } from "@/lib/desk/patience";
import { createThread, loadDaily, loadThreadCapacity, loadUniverseDays, openNextDay } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { defaultPlanDraft, effectiveFirstDay, livePlanProblems, planProblems, startLabel, validatePlanDraft, type PlanDraft, type PlanProblems } from "@/lib/replay/planSetup";
import { latestReplayDay, problemMessage } from "@/lib/replay/setup";
import { defaultThreadDraft, formatBalanceInput, threadProblems, validateThreadDraft, type ThreadDraft, type ThreadProblems } from "@/lib/replay/threadSetup";
import { formatWhole } from "@/lib/replay/threadView";
import { DEFAULT_STARTING_BALANCE } from "@ai-trading/contracts/practice-thread-v1";
import { DayPlanFields } from "./DayPlanFields";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import landing from "./landing.module.css";
import modal from "./newplan.module.css";

type Problems = PlanProblems & ThreadProblems;
/** Where a failed submit stopped: starting the thread or saving its plan. */
type Stage = "thread" | "plan";

const SLOW_START_MS = 10_000;

/**
 * The New plan modal (02r2, Paper mock X9Y-0; redesigned in fix wave 5S, D-075 and D-076): a modal around three things, the
 * filter picker, the day and window settings, and one button that starts the practice. The pretend balance sits on top.
 * "Start 20-day practice" starts the thread, saves the plan, which starts preparing the data and opens Day 1, then
 * `onSaved` takes her to the thread page. There is no Day/Swing choice: the server refuses a swing thread (ADR-0025), so
 * every new thread is a day thread. The risk plan and the armed strategies are not asked here (D-076): the thread takes
 * the server's defaults, and its risk plan is edited in the journal.
 *
 * It is a `ui/Dialog`, which owns the scrim, the focus trap, Escape and the focus handed back to the button that opened it.
 *
 * A plan is never replaced or edited: a new plan is always a new thread. The settings are checked as she edits, and a
 * form she has edited asks before it is thrown away (M-05). Nothing here reaches a broker.
 */
export function NewPlanModal({
  onClose,
  onSaved,
}: {
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
  const [problems, setProblems] = useState<Problems>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Set while the gateway has cut a slow save short and the screen is waiting for the plan to show up (D-058).
  const [still, setStill] = useState(false);
  // A slow start leaves nothing else on screen: after 10 s the footer says it is still working (F-03).
  const [slow, setSlow] = useState(false);
  // The thread started by an earlier try whose plan did not save: a retry continues with it instead of starting another.
  const [startedId, setStartedId] = useState<number | null>(null);
  // Once the Desk has recorded 20 finished days of its universe, a new plan starts on the first one (02o-b2) unless she has picked a day.
  const recorded = useDeskQuery("practice:universe-days", (signal) => loadUniverseDays({}, { signal }));
  const [dayPicked, setDayPicked] = useState(false);
  // Every user shares the day-trade slots (ADR-0022): with all taken a new day thread is refused, so the form says so before she fills it in.
  const capacity = useDeskQuery("thread-capacity", (signal) => loadThreadCapacity({ signal }));
  const dayFull = capacity.data !== null && capacity.data.day_active >= capacity.data.day_max;
  const dayFullText = capacity.data === null ? null : practiceText("daySlotsFull", { max: capacity.data.day_max });
  const recordedDay = recorded.data?.first_day_default ?? null;
  const firstDay = effectiveFirstDay(plan.firstDay, dayPicked, recordedDay);
  // The form as it opened: anything else is an edit, and closing it asks first.
  const snapshot = JSON.stringify({ threadDraft, plan, dayPicked });
  const [pristine] = useState(snapshot);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const noFilters = plan.filterIds.length === 0;

  useEffect(() => {
    if (!submitting) return;
    const timer = setTimeout(() => setSlow(true), SLOW_START_MS);
    return () => clearTimeout(timer);
  }, [submitting]);

  // Escape, Close and a click on the dimmed page all ask first once the form has been edited (M-05).
  const requestClose = () => {
    if (submitting) return;
    if (snapshot !== pristine) setConfirmingDiscard(true);
    else onClose();
  };

  // An edit clears the messages of the last try; the live ones (first day, days, balance) are read from the draft.
  const editThread = (next: ThreadDraft) => {
    setThreadDraft(next);
    setProblems({});
  };
  const editPlan = (next: PlanDraft) => {
    setPlan(next);
    setProblems({});
  };

  async function submit() {
    const day = validatePlanDraft({ ...plan, firstDay }, now);
    const started = validateThreadDraft({ ...threadDraft, mode: "day" });
    const found: Problems = {
      ...(!day.ok ? day.problems : {}),
      ...(!started.ok ? started.problems : {}),
    };
    if (Object.keys(found).length > 0) {
      setProblems(found);
      return;
    }
    setProblems({});
    setFailure(null);
    setStill(false);
    setSlow(false);
    setSubmitting(true);
    let stage: Stage = "thread";
    try {
      if (!day.ok) return;
      let threadId = startedId;
      if (threadId === null && started.ok) {
        threadId = (await createThread(started.spec)).thread.id;
        setStartedId(threadId);
      }
      if (threadId === null) return;
      stage = "plan";
      const id = threadId;
      // The plan id before the save is how a gateway cut is told from a saved plan. A failed read leaves that unknown, and "no plan" would
      // look the same as "unknown" (the old plan would then pass for the new one), so with no id to compare the save is sent plainly.
      const before = await loadDaily({ threadId: id }).then((daily) => ({ id: daily.plan?.id ?? null }), () => null);
      const save = () => openNextDay(day.spec, { threadId: id });
      if (before === null) await save();
      else
        await savePlanPatiently(
          save,
          () => openNextDay(undefined, { threadId: id }),
          () => loadDaily({ threadId: id }).then((daily) => daily.plan?.id ?? null),
          before.id,
          { onWaiting: () => setStill(true) },
        );
      onSaved(id);
    } catch (error) {
      // 422: a field is wrong. 409 on starting a thread: every day-trade slot is taken, and the server names the `mode` field with its sentence.
      if (error instanceof DeskApiError && (error.status === 422 || (error.status === 409 && stage === "thread")) && error.problems.length > 0) {
        setProblems(stage === "thread" ? threadProblems(error.problems) : planProblems(error.problems));
      } else {
        setFailure(problemMessage(error, stage === "thread" ? PRACTICE_COPY.threadStartError : PRACTICE_COPY.newPlanError));
      }
      setStill(false);
      setSlow(false);
      setSubmitting(false);
    }
  }

  const typed = Number(threadDraft.startingBalance.replaceAll(",", ""));
  const shownBalance = threadDraft.startingBalance.trim() === "" || !Number.isFinite(typed) ? DEFAULT_STARTING_BALANCE : typed;
  // What is wrong, as she edits (the draft read now) with what the last try or the server said on top.
  const liveThread: ThreadProblems = (() => {
    const result = validateThreadDraft({ ...threadDraft, mode: "day" });
    return result.ok ? {} : result.problems;
  })();
  const live: Problems = { ...liveThread, ...livePlanProblems({ ...plan, firstDay }, now) };
  const shown: Problems = { ...live, ...problems };
  const { form: formProblem, ...fieldProblems } = shown;
  const formError = failure ?? formProblem ?? null;
  const echo = Object.values(fieldProblems).find((text) => text) ?? null;
  // Why Start is off, in the footer: a problem first, then what is still missing. null means it can start.
  const held = echo ?? (dayFull ? dayFullText : noFilters ? PRACTICE_COPY.planSaveFilterFirst : null);
  const note = practiceText("threadSubmitHint", { balance: formatWhole(shownBalance) });
  const status = confirmingDiscard ? PRACTICE_COPY.newPlanDiscardTitle : still ? PRACTICE_COPY.planStillWorking : submitting && slow ? PRACTICE_COPY.planSlowStart : (held ?? note);

  return (
    <Dialog
      title={PRACTICE_COPY.newPlanTitle}
      size="lg"
      // Escape on the question keeps the form; anywhere else it asks first once the form has been edited.
      onClose={() => (confirmingDiscard ? setConfirmingDiscard(false) : requestClose())}
      headerActions={<Button ref={closeRef} disabled={submitting} onClick={requestClose}>{PRACTICE_COPY.newPlanClose}</Button>}
      onSubmit={(event) => {
        event.preventDefault();
        if (held === null && !submitting && !confirmingDiscard) void submit();
      }}
      footer={
        <>
          <p id="new-plan-note" role="status" className={modal.status}>{status}</p>
          {confirmingDiscard ? (
            <div className={modal.discard}>
              <Button
                autoFocus
                onClick={() => {
                  setConfirmingDiscard(false);
                  closeRef.current?.focus();
                }}
              >
                {PRACTICE_COPY.newPlanDiscardKeep}
              </Button>
              <Button onClick={onClose}>{PRACTICE_COPY.newPlanDiscard}</Button>
            </div>
          ) : (
            <Button
              type="submit"
              variant="primary"
              className={modal.submit}
              loading={submitting}
              aria-disabled={held !== null || submitting || undefined}
              aria-describedby="new-plan-note"
            >
              {submitting && <span className={landing.spinner} aria-hidden="true" />}
              {submitting ? PRACTICE_COPY.newPlanSubmitting : startLabel(plan.sessions, false)}
            </Button>
          )}
        </>
      }
    >
      <p className={modal.help}>{PRACTICE_COPY.newPlanIntroThread}</p>
      <p className={modal.help}>{PRACTICE_COPY.newPlanFooter}</p>

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
      </div>

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

      {formError && <p role="alert" className={modal.fieldError}>{formError}</p>}
      {startedId !== null && failure !== null && <p className={modal.help}>{PRACTICE_COPY.newPlanThreadKept}</p>}
    </Dialog>
  );
}
