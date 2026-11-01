"use client";

import { Segments } from "@/components/practice/hub/FormCells";
import { Field, Input, NumberInput } from "@/components/ui/Field";
import modal from "@/components/practice/hub/newplan.module.css";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { EARLIEST_SWING_DAY, MAX_OPEN_HOLDS, MAX_SESSIONS, MIN_SESSIONS, SWING_INTERVALS, SWING_TAPES, calendarLine, type SwingDraft, type SwingProblems } from "@/lib/replay/swingSetup";
import { latestReplayDay } from "@/lib/replay/setup";
import { UniverseBuilder } from "./UniverseBuilder";
import type { UniversePreviewState } from "./useUniversePreview";

const TAPE_LABEL = { off: PRACTICE_COPY.swingTapeNo, on: PRACTICE_COPY.swingTapeYes } as const;

/**
 * The Swing section of the New plan modal (02p c1, D-075): the settings in the same two-column grid as the day plan, then the
 * universe builder. The thread's own balance sits above in the modal; its risk plan is not asked here (D-076). The modal owns
 * the draft, the preview and the submit; this section only edits them.
 */
export function SwingSetupSection({
  draft,
  onDraft,
  preview,
  problems,
  now,
}: {
  draft: SwingDraft;
  onDraft: (draft: SwingDraft) => void;
  preview: UniversePreviewState;
  problems: SwingProblems;
  now: Date;
}) {
  return (
    <>
      <fieldset className={modal.section}>
        <legend className={modal.legend}>{PRACTICE_COPY.newPlanSettings}</legend>
        <p className={modal.help}>{PRACTICE_COPY.swingSetupHint}</p>
        <div className={modal.grid}>
          <Field id="swing-first-day" label={PRACTICE_COPY.swingFirstDay} error={problems.firstDay} reserve>
            <Input type="date" value={draft.firstDay} min={EARLIEST_SWING_DAY} max={latestReplayDay(now)} onChange={(event) => onDraft({ ...draft, firstDay: event.target.value })} />
          </Field>
          <Field id="swing-sessions" label={PRACTICE_COPY.swingSessions} note={calendarLine(draft)} error={problems.sessions}>
            <NumberInput fill inputMode="numeric" min={MIN_SESSIONS} max={MAX_SESSIONS} step={1} value={draft.sessions} onChange={(event) => onDraft({ ...draft, sessions: event.target.value })} />
          </Field>
          <Field id="swing-hide" label={PRACTICE_COPY.swingHideDates} group note={PRACTICE_COPY.planHideDatesHint} error={problems.hideDates}>
            <Segments
              id="swing-hide"
              value={draft.hideDates ? "yes" : "no"}
              options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
              onChange={(value) => onDraft({ ...draft, hideDates: value === "yes" })}
            />
          </Field>
          <Field id="swing-max-open" label={PRACTICE_COPY.swingMaxOpen} error={problems.maxOpenHolds}>
            <NumberInput fill inputMode="numeric" min={1} max={MAX_OPEN_HOLDS} step={1} value={draft.maxOpenHolds} onChange={(event) => onDraft({ ...draft, maxOpenHolds: event.target.value })} />
          </Field>
          <Field id="swing-interval" label={PRACTICE_COPY.swingInterval} group error={problems.interval}>
            <Segments
              id="swing-interval"
              value={draft.interval}
              options={SWING_INTERVALS.map((value) => ({ value, label: value }))}
              onChange={(interval) => onDraft({ ...draft, interval })}
            />
          </Field>
          <Field id="swing-risk" label={PRACTICE_COPY.swingRiskPerHold} error={problems.riskPerHoldUsd}>
            <NumberInput fill inputMode="numeric" min={1} max={100000} step={1} placeholder="Optional" value={draft.riskPerHoldUsd} onChange={(event) => onDraft({ ...draft, riskPerHoldUsd: event.target.value })} />
          </Field>
          <Field id="swing-tape" label={PRACTICE_COPY.swingTape} group error={problems.tape}>
            <Segments
              id="swing-tape"
              value={draft.tape}
              options={SWING_TAPES.map((value) => ({ value, label: TAPE_LABEL[value] }))}
              onChange={(tape) => onDraft({ ...draft, tape })}
            />
          </Field>
        </div>
      </fieldset>

      <UniverseBuilder draft={draft} onDraft={onDraft} state={preview} problems={problems} />
    </>
  );
}
