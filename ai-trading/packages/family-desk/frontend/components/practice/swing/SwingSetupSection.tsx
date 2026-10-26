"use client";

import type { ReactNode } from "react";
import { ArmStrategiesField } from "@/components/practice/hub/ArmStrategiesField";
import hub from "@/components/practice/hub/hub.module.css";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { EARLIEST_SWING_DAY, MAX_OPEN_HOLDS, MAX_SESSIONS, MIN_SESSIONS, SWING_INTERVALS, SWING_TAPES, calendarLine, type SwingDraft, type SwingProblems } from "@/lib/replay/swingSetup";
import { latestReplayDay } from "@/lib/replay/setup";
import { UniverseBuilder } from "./UniverseBuilder";
import type { UniversePreviewState } from "./useUniversePreview";

const TAPE_LABEL = { off: PRACTICE_COPY.swingTapeNo, on: PRACTICE_COPY.swingTapeYes } as const;

/**
 * The Swing section of the New thread form (02p c1): the days, the universe builder, and the swing plan. The thread's own
 * risk plan fields come in as `children` and sit in the plan section, because in a swing thread they count per week.
 * The form owns the draft, the preview and the submit; this section only edits them.
 */
export function SwingSetupSection({
  draft,
  onDraft,
  preview,
  problems,
  now,
  children,
}: {
  draft: SwingDraft;
  onDraft: (draft: SwingDraft) => void;
  preview: UniversePreviewState;
  problems: SwingProblems;
  now: Date;
  children?: ReactNode;
}) {
  const calendar = calendarLine(draft);
  return (
    <>
      <fieldset className={hub.group}>
        <legend className={hub.legend}>{PRACTICE_COPY.swingDaysSection}</legend>
        <p className={hub.hint}>{PRACTICE_COPY.swingSetupHint}</p>
        <div className={hub.row}>
          <Field id="swing-first-day" label={PRACTICE_COPY.swingFirstDay} error={problems.firstDay}>
            <input
              id="swing-first-day"
              type="date"
              className={hub.control}
              value={draft.firstDay}
              min={EARLIEST_SWING_DAY}
              max={latestReplayDay(now)}
              aria-invalid={problems.firstDay ? true : undefined}
              aria-describedby={problems.firstDay ? "swing-first-day-error" : undefined}
              onChange={(event) => onDraft({ ...draft, firstDay: event.target.value })}
            />
          </Field>
          <Field id="swing-sessions" label={PRACTICE_COPY.swingSessions} error={problems.sessions}>
            <input
              id="swing-sessions"
              type="number"
              inputMode="numeric"
              min={MIN_SESSIONS}
              max={MAX_SESSIONS}
              step={1}
              className={hub.control}
              value={draft.sessions}
              aria-invalid={problems.sessions ? true : undefined}
              aria-describedby={problems.sessions ? "swing-sessions-error" : undefined}
              onChange={(event) => onDraft({ ...draft, sessions: event.target.value })}
            />
          </Field>
          <Choice
            id="swing-hide"
            label={PRACTICE_COPY.swingHideDates}
            error={problems.hideDates}
            value={draft.hideDates ? "yes" : "no"}
            options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
            onChange={(value) => onDraft({ ...draft, hideDates: value === "yes" })}
          />
        </div>
        {calendar && <p className={hub.muted}>{calendar}</p>}
      </fieldset>

      <UniverseBuilder draft={draft} onDraft={onDraft} state={preview} problems={problems} />

      <fieldset className={hub.group}>
        <legend className={hub.legend}>{PRACTICE_COPY.swingPlanSection}</legend>
        <div className={hub.row}>
          <Field id="swing-max-open" label={PRACTICE_COPY.swingMaxOpen} error={problems.maxOpenHolds}>
            <input
              id="swing-max-open"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_OPEN_HOLDS}
              step={1}
              className={hub.control}
              value={draft.maxOpenHolds}
              aria-invalid={problems.maxOpenHolds ? true : undefined}
              aria-describedby={problems.maxOpenHolds ? "swing-max-open-error" : undefined}
              onChange={(event) => onDraft({ ...draft, maxOpenHolds: event.target.value })}
            />
          </Field>
          <Field id="swing-risk" label={PRACTICE_COPY.swingRiskPerHold} error={problems.riskPerHoldUsd}>
            <input
              id="swing-risk"
              type="number"
              inputMode="numeric"
              min={1}
              max={100000}
              step={1}
              placeholder="Optional"
              className={hub.control}
              value={draft.riskPerHoldUsd}
              aria-invalid={problems.riskPerHoldUsd ? true : undefined}
              aria-describedby={problems.riskPerHoldUsd ? "swing-risk-error" : undefined}
              onChange={(event) => onDraft({ ...draft, riskPerHoldUsd: event.target.value })}
            />
          </Field>
          <Choice
            id="swing-interval"
            label={PRACTICE_COPY.swingInterval}
            error={problems.interval}
            value={draft.interval}
            options={SWING_INTERVALS.map((value) => ({ value, label: value }))}
            onChange={(interval) => onDraft({ ...draft, interval })}
          />
          <Choice
            id="swing-tape"
            label={PRACTICE_COPY.swingTape}
            error={problems.tape}
            value={draft.tape}
            options={SWING_TAPES.map((value) => ({ value, label: TAPE_LABEL[value] }))}
            onChange={(tape) => onDraft({ ...draft, tape })}
          />
        </div>
        <ArmStrategiesField armed={draft.armed} onChange={(armed) => onDraft({ ...draft, armed })} error={problems.armed} dailyOnly />
        {children}
      </fieldset>
    </>
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return (
    <div className={hub.field}>
      <label htmlFor={id} className={hub.label}>{label}</label>
      {children}
      {error && <p id={`${id}-error`} role="alert" className={hub.fieldError}>{error}</p>}
    </div>
  );
}

/** A small set of toggle buttons (aria-pressed) grouped under their label, like the plan form's Yes and No. */
function Choice<T extends string>({
  id,
  label,
  error,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  error?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className={hub.field}>
      <span id={`${id}-label`} className={hub.label}>{label}</span>
      <div role="group" aria-labelledby={`${id}-label`} className={hub.segmented}>
        {options.map((option) => (
          <button key={option.value} type="button" className={hub.segment} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
      {error && <p role="alert" className={hub.fieldError}>{error}</p>}
    </div>
  );
}
