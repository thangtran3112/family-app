"use client";

import { useEffect, useRef, useState } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { ThreadPlanFields } from "@/components/practice/thread/ThreadPlanFields";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { DeskApiError, type DeskApiProblem } from "@/lib/api/client";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { createThread, loadThreadCapacity, loadUniverseDays } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { defaultPlanDraft, effectiveStartDay, livePlanProblems, planFieldOfPath, planProblems, startLabel, validatePlanDraft, type PlanDraft, type PlanProblems } from "@/lib/replay/planSetup";
import { latestReplayDay, problemMessage } from "@/lib/replay/setup";
import { defaultThreadDraft, formatBalanceInput, threadProblems, validateThreadDraft, type ThreadDraft, type ThreadProblems } from "@/lib/replay/threadSetup";
import { formatWhole } from "@/lib/replay/threadView";
import { DEFAULT_STARTING_BALANCE } from "@ai-trading/contracts/practice-thread-v1";
import { PlanFields } from "./PlanFields";
import landing from "./landing.module.css";
import modal from "./newplan.module.css";

type Problems = PlanProblems & ThreadProblems;

const SLOW_START_MS = 10_000;

/** Server problems to the form's fields: a path of the setup (`startAt`, `screen.filters`) is the setup half's, anything else the thread's (`startingBalance`, `plan.maxLossUsd`, and `mode` for "every slot is taken"). */
const serverProblems = (problems: readonly DeskApiProblem[]): Problems => ({
  ...threadProblems(problems.filter((problem) => planFieldOfPath(problem.path) === "form")),
  ...planProblems(problems.filter((problem) => planFieldOfPath(problem.path) !== "form")),
});

/**
 * The New thread modal (02r2, Paper mock X9Y-0; ADR-0025): a modal around the pretend balance, the filter picker, the start (a date and a time,
 * 9:30 AM ET unless she picks another) and the chart interval, the Screen size, and optional risk rules, with one button, "Start thread". There is
 * no fixed course length, no list time and no Swing choice: a thread is a pretend account with one clock, and it starts at the instant she picks.
 * "Start thread" sends one request, `POST /threads` with the thread's body and the setup beside it, which starts the thread's clock paused
 * at the start instant and builds its Screen; `onSaved` takes her to the thread page. The armed strategies are not asked here (D-076).
 *
 * It is a `ui/Dialog`, which owns the scrim, the focus trap, Escape and the focus handed back to the button that opened it.
 *
 * A setup is never edited: a new setup is a new thread. The settings are checked as she edits, and a form she has edited asks before it is
 * thrown away (M-05). Nothing here reaches a broker.
 */
export function NewPlanModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  /** The thread and its setup are saved; the page decides where to go next. */
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
  // A slow start leaves nothing else on screen: after 10 s the footer says it is still working (F-03).
  const [slow, setSlow] = useState(false);
  // Once the Desk has recorded 20 finished days of its universe, a new thread starts on the first one (02o-b2) unless she has picked a day.
  const recorded = useDeskQuery("practice:universe-days", (signal) => loadUniverseDays({}, { signal }));
  const [dayPicked, setDayPicked] = useState(false);
  // Every user shares the thread slots (ADR-0025): with all taken a new thread is refused, so the form says so before she fills it in.
  const capacity = useDeskQuery("thread-capacity", (signal) => loadThreadCapacity({ signal }));
  const full = capacity.data !== null && capacity.data.day_active >= capacity.data.day_max;
  const fullText = capacity.data === null ? null : practiceText("threadSlotsFull", { max: capacity.data.day_max });
  const recordedDay = recorded.data?.first_day_default ?? null;
  const startDay = effectiveStartDay(plan.startDay, dayPicked, recordedDay);
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

  // An edit clears the messages of the last try; the live ones (start, size, balance) are read from the draft.
  const editThread = (next: ThreadDraft) => {
    setThreadDraft(next);
    setProblems({});
  };
  const editPlan = (next: PlanDraft) => {
    setPlan(next);
    setProblems({});
  };

  async function submit() {
    const setup = validatePlanDraft({ ...plan, startDay }, now);
    const started = validateThreadDraft(threadDraft);
    const found: Problems = {
      ...(!setup.ok ? setup.problems : {}),
      ...(!started.ok ? started.problems : {}),
    };
    if (Object.keys(found).length > 0 || !setup.ok || !started.ok) {
      setProblems(found);
      return;
    }
    setProblems({});
    setFailure(null);
    setSlow(false);
    setSubmitting(true);
    try {
      // ponytail: one request, no retry-by-id; the setup is built inline, so a gateway cut leaves at worst a thread to delete. Add polling if the Desk starts preparing data here.
      const created = await createThread({ ...started.spec, setup: setup.spec });
      onSaved(created.thread.id);
    } catch (error) {
      // 422: a field is wrong. 409: every thread slot is taken, and the server names the `mode` field with its sentence.
      if (error instanceof DeskApiError && (error.status === 422 || error.status === 409) && error.problems.length > 0) {
        setProblems(serverProblems(error.problems));
      } else {
        setFailure(problemMessage(error, PRACTICE_COPY.newThreadError));
      }
      setSlow(false);
      setSubmitting(false);
    }
  }

  const typed = Number(threadDraft.startingBalance.replaceAll(",", ""));
  const shownBalance = threadDraft.startingBalance.trim() === "" || !Number.isFinite(typed) ? DEFAULT_STARTING_BALANCE : typed;
  // What is wrong, as she edits (the draft read now) with what the last try or the server said on top.
  const liveThread: ThreadProblems = (() => {
    const result = validateThreadDraft(threadDraft);
    return result.ok ? {} : result.problems;
  })();
  const live: Problems = { ...liveThread, ...livePlanProblems({ ...plan, startDay }, now) };
  const shown: Problems = { ...live, ...problems };
  const { form: formProblem, ...fieldProblems } = shown;
  const formError = failure ?? formProblem ?? null;
  const echo = Object.values(fieldProblems).find((text) => text) ?? null;
  // Why Start is off, in the footer: a problem first, then what is still missing. null means it can start.
  const held = echo ?? (full ? fullText : noFilters ? PRACTICE_COPY.newThreadFilterFirst : null);
  const note = practiceText("threadSubmitHint", { balance: formatWhole(shownBalance) });
  const status = confirmingDiscard ? PRACTICE_COPY.newPlanDiscardTitle : submitting && slow ? PRACTICE_COPY.newThreadSlowStart : (held ?? note);

  return (
    <Dialog
      title={PRACTICE_COPY.newThreadTitle}
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
              {submitting ? PRACTICE_COPY.newThreadSubmitting : startLabel()}
            </Button>
          )}
        </>
      }
    >
      <p className={modal.help}>{PRACTICE_COPY.newThreadIntro}</p>
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

      <PlanFields
        draft={plan}
        onDraft={editPlan}
        problems={shown}
        startDay={startDay}
        startDayNote={recorded.data?.first_day_note ?? null}
        maxDay={latestReplayDay(now)}
        onStartDay={(day) => {
          setDayPicked(true);
          editPlan({ ...plan, startDay: day });
        }}
      />

      <fieldset className={modal.section}>
        <legend className={modal.legend}>{PRACTICE_COPY.newThreadRisk}</legend>
        <p className={modal.help}>{PRACTICE_COPY.newThreadRiskHint}</p>
        <ThreadPlanFields draft={threadDraft} onDraft={editThread} problems={shown} idPrefix="new-thread" shares={false} />
      </fieldset>

      {formError && <p role="alert" className={modal.fieldError}>{formError}</p>}
    </Dialog>
  );
}
