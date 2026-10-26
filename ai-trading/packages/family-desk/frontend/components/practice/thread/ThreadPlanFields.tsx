"use client";

import type { ReactNode } from "react";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { ThreadDraft, ThreadProblems } from "@/lib/replay/threadSetup";
import styles from "./thread.module.css";

/** The risk plan of a practice thread (02r, D-007): stop on every entry, trade only on a signal, max loss, max trades and a
 *  note. Shared by the hub's New thread form and the journal's Edit plan form; the parent owns the draft. `idPrefix` keeps
 *  the ids unique when two forms are on screen. `perWeek` (a swing thread, 02p) labels max loss and max trades as weekly. */
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
          <input
            id={id("max-loss")}
            type="number"
            inputMode="numeric"
            min={1}
            max={100000}
            step={1}
            placeholder="Optional"
            className={styles.control}
            value={draft.maxLossUsd}
            aria-invalid={problems.maxLossUsd ? true : undefined}
            aria-describedby={problems.maxLossUsd ? `${id("max-loss")}-error` : undefined}
            onChange={(event) => onDraft({ ...draft, maxLossUsd: event.target.value })}
          />
        </Field>
        <Field id={id("max-trades")} label={perWeek ? PRACTICE_COPY.swingMaxTradesWeek : PRACTICE_COPY.threadMaxTrades} error={problems.maxTrades}>
          <input
            id={id("max-trades")}
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            step={1}
            placeholder="Optional"
            className={styles.control}
            value={draft.maxTrades}
            aria-invalid={problems.maxTrades ? true : undefined}
            aria-describedby={problems.maxTrades ? `${id("max-trades")}-error` : undefined}
            onChange={(event) => onDraft({ ...draft, maxTrades: event.target.value })}
          />
        </Field>
      </div>
      {perWeek && <p className={styles.hint}>{PRACTICE_COPY.swingPerWeekNote}</p>}
      <Field id={id("note")} label={`${PRACTICE_COPY.threadPlanNote} · 500 characters`} error={problems.planNote} wide>
        <textarea
          id={id("note")}
          rows={3}
          maxLength={500}
          className={styles.textarea}
          value={draft.planNote}
          aria-invalid={problems.planNote ? true : undefined}
          aria-describedby={problems.planNote ? `${id("note")}-error` : undefined}
          onChange={(event) => onDraft({ ...draft, planNote: event.target.value })}
        />
      </Field>
    </div>
  );
}

function Field({ id, label, error, wide, children }: { id: string; label: string; error?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? `${styles.field} ${styles.wide}` : styles.field}>
      <label htmlFor={id} className={styles.label}>{label}</label>
      {children}
      {error && <p id={`${id}-error`} role="alert" className={styles.fieldError}>{error}</p>}
    </div>
  );
}

/** A yes-or-no pair of toggle buttons (aria-pressed), grouped under the question. */
function YesNo({ id, label, value, error, onChange }: { id: string; label: string; value: boolean; error?: string; onChange: (value: boolean) => void }) {
  return (
    <div className={styles.field}>
      <span id={`${id}-label`} className={styles.label}>{label}</span>
      <div role="group" aria-labelledby={`${id}-label`} className={styles.segmented}>
        <button type="button" className={styles.segment} aria-pressed={value} onClick={() => onChange(true)}>Yes</button>
        <button type="button" className={styles.segment} aria-pressed={!value} onClick={() => onChange(false)}>No</button>
      </div>
      {error && <p role="alert" className={styles.fieldError}>{error}</p>}
    </div>
  );
}
