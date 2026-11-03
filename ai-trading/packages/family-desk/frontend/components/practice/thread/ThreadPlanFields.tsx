"use client";

import { Field, NumberInput, Textarea } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { ThreadDraft, ThreadProblems } from "@/lib/replay/threadSetup";
import styles from "./thread.module.css";

/** The optional risk rules of a practice thread (02r, D-007, ADR-0025): trade only on a signal, max loss, max trades and a note, each counted
 *  for an ET date of the thread's clock. The New thread modal and the journal's Edit plan form use it; the parent owns the draft. `idPrefix`
 *  keeps the ids unique when two forms are on screen. `shares` shows the entry size tickets open at (D-042), which only an existing thread can set. */
export function ThreadPlanFields({
  draft,
  onDraft,
  problems,
  idPrefix,
  shares = true,
}: {
  draft: ThreadDraft;
  onDraft: (draft: ThreadDraft) => void;
  problems: ThreadProblems;
  idPrefix: string;
  shares?: boolean;
}) {
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <div className={styles.group}>
      <div className={styles.row}>
        <YesNo id={id("signal")} label={PRACTICE_COPY.threadSignalOnly} value={draft.tradeOnlyOnSignal} error={problems.tradeOnlyOnSignal} onChange={(tradeOnlyOnSignal) => onDraft({ ...draft, tradeOnlyOnSignal })} />
      </div>
      {shares && (
        <Field id={id("shares")} label={PRACTICE_COPY.threadShares} error={problems.shares}>
          <NumberInput fill inputMode="numeric" min={1} step={1} placeholder={PRACTICE_COPY.threadSharesPlaceholder} value={draft.shares} onChange={(event) => onDraft({ ...draft, shares: event.target.value })} />
        </Field>
      )}
      <div className={styles.row}>
        <Field id={id("max-loss")} label={PRACTICE_COPY.threadMaxLoss} error={problems.maxLossUsd}>
          <NumberInput fill inputMode="numeric" min={1} max={100000} step={1} placeholder="Optional" value={draft.maxLossUsd} onChange={(event) => onDraft({ ...draft, maxLossUsd: event.target.value })} />
        </Field>
        <Field id={id("max-trades")} label={PRACTICE_COPY.threadMaxTrades} error={problems.maxTrades}>
          <NumberInput fill inputMode="numeric" min={1} max={50} step={1} placeholder="Optional" value={draft.maxTrades} onChange={(event) => onDraft({ ...draft, maxTrades: event.target.value })} />
        </Field>
      </div>
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
      <Segmented value={value ? "yes" : "no"} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} onChange={(next) => onChange(next === "yes")} />
    </Field>
  );
}
