"use client";

import type { ReactNode } from "react";
import type { FieldProblems, SetupDraft } from "@/lib/replay/setup";
import styles from "./hub.module.css";

/** The plan (02o §a2): shares, stop and signal rules, a max loss and trade count, and a short note. Shown as plain fields. */
export function PlanFields({ draft, onDraft, problems }: { draft: SetupDraft; onDraft: (draft: SetupDraft) => void; problems: FieldProblems }) {
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>Plan</legend>
      <div className={styles.row}>
        <PlanField id="plan-shares" label="Shares" error={problems.shares}>
          <input
            id="plan-shares"
            type="number"
            inputMode="numeric"
            min={1}
            max={10000}
            step={1}
            className={styles.control}
            value={draft.shares}
            aria-invalid={problems.shares ? true : undefined}
            aria-describedby={problems.shares ? "plan-shares-error" : undefined}
            onChange={(event) => onDraft({ ...draft, shares: event.target.value })}
          />
        </PlanField>
        <YesNo id="plan-stop" label="Stop on every entry" value={draft.stopRequired} error={problems.stopRequired} onChange={(stopRequired) => onDraft({ ...draft, stopRequired })} />
        <YesNo id="plan-signal" label="Trade only on a signal" value={draft.signalOnly} onChange={(signalOnly) => onDraft({ ...draft, signalOnly })} />
      </div>
      <div className={styles.row}>
        <PlanField id="plan-max-loss" label="Max loss ($)" error={problems.maxLossUsd}>
          <input
            id="plan-max-loss"
            type="number"
            inputMode="numeric"
            min={1}
            max={100000}
            step={1}
            placeholder="Optional"
            className={styles.control}
            value={draft.maxLossUsd}
            aria-invalid={problems.maxLossUsd ? true : undefined}
            aria-describedby={problems.maxLossUsd ? "plan-max-loss-error" : undefined}
            onChange={(event) => onDraft({ ...draft, maxLossUsd: event.target.value })}
          />
        </PlanField>
        <PlanField id="plan-max-trades" label="Max trades" error={problems.maxTrades}>
          <input
            id="plan-max-trades"
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            step={1}
            placeholder="Optional"
            className={styles.control}
            value={draft.maxTrades}
            aria-invalid={problems.maxTrades ? true : undefined}
            aria-describedby={problems.maxTrades ? "plan-max-trades-error" : undefined}
            onChange={(event) => onDraft({ ...draft, maxTrades: event.target.value })}
          />
        </PlanField>
      </div>
      <PlanField id="plan-note" label="Plan note" error={problems.note} wide>
        <textarea
          id="plan-note"
          rows={3}
          maxLength={500}
          className={styles.textarea}
          value={draft.note}
          aria-invalid={problems.note ? true : undefined}
          aria-describedby={problems.note ? "plan-note-error" : undefined}
          onChange={(event) => onDraft({ ...draft, note: event.target.value })}
        />
      </PlanField>
    </fieldset>
  );
}

function PlanField({ id, label, error, wide, children }: { id: string; label: string; error?: string; wide?: boolean; children: ReactNode }) {
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
