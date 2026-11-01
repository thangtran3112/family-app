"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { ThreadPlanFields } from "@/components/practice/thread/ThreadPlanFields";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { closeThread, patchThread } from "@/lib/desk/replay";
import { problemMessage } from "@/lib/replay/setup";
import { HUB_SWING_COPY, weeklyPlanRows } from "@/lib/replay/hubSwing";
import { planRows } from "@/lib/replay/threadView";
import { planToDraft, threadProblems, validatePlanEdit, type ThreadDraft, type ThreadProblems } from "@/lib/replay/threadSetup";
import type { Thread } from "@/lib/replay/threads";
import styles from "./threadJournal.module.css";
import { FactList } from "@/components/ui/FactList";

/** The thread's risk plan (02r): read-only rows with the plan note, and an Edit plan form while the thread is active. */
export function ThreadPlanPanel({ thread, onChanged }: { thread: Thread; onChanged: () => void }) {
  const { id, plan, startingBalance, status, mode } = thread.thread;
  const swing = mode === "swing";
  const closed = status === "closed";
  const [draft, setDraft] = useState<ThreadDraft | null>(null);
  const [problems, setProblems] = useState<ThreadProblems>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = saving;

  const edit = () => {
    setDraft(planToDraft(plan, startingBalance));
    setProblems({});
    setSaveError(null);
  };

  const cancel = () => {
    setDraft(null);
    setProblems({});
    setSaveError(null);
  };

  const save = async () => {
    if (draft === null) return;
    const result = validatePlanEdit(draft, startingBalance);
    if (!result.ok) {
      setProblems(result.problems);
      return;
    }
    setSaving(true);
    setProblems({});
    setSaveError(null);
    try {
      await patchThread(id, result.spec);
      setDraft(null);
      onChanged();
    } catch (error) {
      const mapped = threadProblems(error instanceof DeskApiError ? error.problems : []);
      if (Object.keys(mapped).length > 0 && mapped.form === undefined) setProblems(mapped);
      else setSaveError(mapped.form ?? problemMessage(error, PRACTICE_COPY.threadPlanSaveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.stack}>
      {!closed && draft === null && (
        <div className={styles.headRow}>
          <p className={styles.planNote}>{PRACTICE_COPY.threadPlanCaption}</p>
          <Button onClick={edit} disabled={busy}>{PRACTICE_COPY.threadEditPlan}</Button>
        </div>
      )}

      {draft !== null ? (
        <form
          className={styles.form}
          aria-label={PRACTICE_COPY.threadEditPlan}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <ThreadPlanFields draft={draft} onDraft={setDraft} problems={problems} idPrefix="edit-plan" perWeek={swing} />
          <p className={styles.muted}>{PRACTICE_COPY.threadPlanApplies}</p>
          {saveError && <p role="alert" className={styles.alert}>{saveError}</p>}
          <div className={styles.actions}>
            <Button type="submit" variant="primary" disabled={busy}>{PRACTICE_COPY.threadSavePlan}</Button>
            <Button onClick={cancel} disabled={busy}>Cancel</Button>
          </div>
        </form>
      ) : (
        <>
          <FactList
            divided
            facts={(swing ? weeklyPlanRows(planRows(plan)) : planRows(plan)).map((row) => ({
              id: row.id,
              label: row.label,
              value: (
                <>
                  {row.value}
                  {row.id === "max_loss" && row.value !== "None" && <SimulatedBadge />}
                </>
              ),
            }))}
          />
          {swing && <p className={styles.planNote}>{PRACTICE_COPY.swingPerWeekNote}</p>}
          <p className={styles.planNote}>{`${PRACTICE_COPY.threadPlanNote}: ${plan.planNote ?? PRACTICE_COPY.threadPlanNoteNone}`}</p>
        </>
      )}

    </div>
  );
}

/** Close thread (02r), in its own section of the rail (D-040): the caption, the reason and a confirmation before anything closes. */
export function CloseThreadPanel({ thread, onChanged }: { thread: Thread; onChanged: () => void }) {
  const { id, status, mode } = thread.thread;
  const [confirming, setConfirming] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  if (status === "closed") return <p className={styles.muted}>{PRACTICE_COPY.threadClosedBody}</p>;

  const close = async () => {
    setClosing(true);
    setCloseError(null);
    try {
      await closeThread(id);
      setConfirming(false);
      onChanged();
    } catch (error) {
      setCloseError(problemMessage(error, PRACTICE_COPY.threadCloseError));
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className={styles.stack}>
      <Button ref={closeRef} variant="danger" onClick={() => setConfirming(true)} disabled={closing}>{PRACTICE_COPY.threadClose}</Button>
      <p className={styles.muted}>{PRACTICE_COPY.threadCloseCaption}</p>
      {mode === "swing" && <p className={styles.muted}>{HUB_SWING_COPY.closeSwingNote}</p>}
      <p className={styles.muted}>{PRACTICE_COPY.threadCloseReason}</p>
      {confirming && (
        <InlineConfirm
          label="Confirm closing the thread"
          size="md"
          tone="danger"
          confirmLabel={PRACTICE_COPY.threadCloseConfirm}
          cancelLabel={PRACTICE_COPY.threadCloseKeep}
          busy={closing}
          returnFocus={closeRef}
          onConfirm={close}
          onCancel={() => setConfirming(false)}
        />
      )}
      {closeError && <p role="alert" className={styles.alert}>{closeError}</p>}
    </div>
  );
}
