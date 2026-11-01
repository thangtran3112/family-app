"use client";

import { Segments } from "@/components/practice/hub/FormCells";
import { Field, NumberInput, Textarea } from "@/components/ui/Field";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { ThreadDraft, ThreadProblems } from "@/lib/replay/threadSetup";
import styles from "./thread.module.css";

/** The risk plan of a practice thread (02r, D-007): stop on every entry, trade only on a signal, max loss, max trades and a
 *  note. The journal's Edit plan form uses it (the New plan modal no longer asks for a risk plan, D-076); the parent owns the
 *  draft. `idPrefix` keeps the ids unique when two forms are on screen. `perWeek` (a swing thread, 02p) labels max loss and
 *  max trades as weekly. */
export function ThreadPlanFields({
  draft,
  onDraft,
  problems,
  idPrefix,
  perWeek = false,
}: {
  draft: ThreadDraft;
  onDraft: (draft: ThreadDraft) => void;
  problems: ThreadProblems;
  idPrefix: string;
  perWeek?: boolean;
}) {
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <div className={styles.group}>
      <div className={styles.row}>
        <YesNo id={id("stop")} label={PRACTICE_COPY.threadStopOnEntry} value={draft.stopNoteOnEntry} error={problems.stopNoteOnEntry} onChange={(stopNoteOnEntry) => onDraft({ ...draft, stopNoteOnEntry })} />
        <YesNo id={id("signal")} label={PRACTICE_COPY.threadSignalOnly} value={draft.tradeOnlyOnSignal} error={problems.tradeOnlyOnSignal} onChange={(tradeOnlyOnSignal) => onDraft({ ...draft, tradeOnlyOnSignal })} />
      </div>
      <div className={styles.row}>
        <Field id={id("max-loss")} label={perWeek ? PRACTICE_COPY.swingMaxLossWeek : PRACTICE_COPY.threadMaxLoss} error={problems.maxLossUsd}>
          <NumberInput fill inputMode="numeric" min={1} max={100000} step={1} placeholder="Optional" value={draft.maxLossUsd} onChange={(event) => onDraft({ ...draft, maxLossUsd: event.target.value })} />
        </Field>
        <Field id={id("max-trades")} label={perWeek ? PRACTICE_COPY.swingMaxTradesWeek : PRACTICE_COPY.threadMaxTrades} error={problems.maxTrades}>
          <NumberInput fill inputMode="numeric" min={1} max={50} step={1} placeholder="Optional" value={draft.maxTrades} onChange={(event) => onDraft({ ...draft, maxTrades: event.target.value })} />
        </Field>
      </div>
      {perWeek && <p className={styles.hint}>{PRACTICE_COPY.swingPerWeekNote}</p>}
      <Field id={id("note")} label={`${PRACTICE_COPY.threadPlanNote} · 500 characters`} error={problems.planNote} className={styles.wide}>
        <Textarea rows={3} maxLength={500} value={draft.planNote} onChange={(event) => onDraft({ ...draft, planNote: event.target.value })} />
      </Field>
    </div>
  );
}

/** A yes-or-no question: the kit's labelled group around a two-option segmented control. */
function YesNo({ id, label, value, error, onChange }: { id: string; label: string; value: boolean; error?: string; onChange: (value: boolean) => void }) {
  return (
    <Field id={id} label={label} group error={error}>
      <Segments id={id} value={value ? "yes" : "no"} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} onChange={(next) => onChange(next === "yes")} />
    </Field>
  );
}
