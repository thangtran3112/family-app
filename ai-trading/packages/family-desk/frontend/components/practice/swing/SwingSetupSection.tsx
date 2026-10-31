"use client";

import { Cell, Segments, noteId } from "@/components/practice/hub/FormCells";
import hub from "@/components/practice/hub/hub.module.css";
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
          <Cell id="swing-first-day" label={PRACTICE_COPY.swingFirstDay} error={problems.firstDay} reserve>
            <input
              id="swing-first-day"
              type="date"
              className={hub.control}
              value={draft.firstDay}
              min={EARLIEST_SWING_DAY}
              max={latestReplayDay(now)}
              aria-invalid={problems.firstDay ? true : undefined}
              aria-describedby={noteId("swing-first-day")}
              onChange={(event) => onDraft({ ...draft, firstDay: event.target.value })}
            />
          </Cell>
          <Cell id="swing-sessions" label={PRACTICE_COPY.swingSessions} note={calendarLine(draft)} error={problems.sessions}>
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
              aria-describedby={noteId("swing-sessions")}
              onChange={(event) => onDraft({ ...draft, sessions: event.target.value })}
            />
          </Cell>
          <Cell id="swing-hide" label={PRACTICE_COPY.swingHideDates} group note={PRACTICE_COPY.planHideDatesHint} error={problems.hideDates}>
            <Segments
              id="swing-hide"
              value={draft.hideDates ? "yes" : "no"}
              options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
              onChange={(value) => onDraft({ ...draft, hideDates: value === "yes" })}
              describedBy={noteId("swing-hide")}
            />
          </Cell>
          <Cell id="swing-max-open" label={PRACTICE_COPY.swingMaxOpen} error={problems.maxOpenHolds}>
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
              aria-describedby={problems.maxOpenHolds ? noteId("swing-max-open") : undefined}
              onChange={(event) => onDraft({ ...draft, maxOpenHolds: event.target.value })}
            />
          </Cell>
          <Cell id="swing-interval" label={PRACTICE_COPY.swingInterval} group error={problems.interval}>
            <Segments
              id="swing-interval"
              value={draft.interval}
              options={SWING_INTERVALS.map((value) => ({ value, label: value }))}
              onChange={(interval) => onDraft({ ...draft, interval })}
            />
          </Cell>
          <Cell id="swing-risk" label={PRACTICE_COPY.swingRiskPerHold} error={problems.riskPerHoldUsd}>
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
              aria-describedby={problems.riskPerHoldUsd ? noteId("swing-risk") : undefined}
              onChange={(event) => onDraft({ ...draft, riskPerHoldUsd: event.target.value })}
            />
          </Cell>
          <Cell id="swing-tape" label={PRACTICE_COPY.swingTape} group error={problems.tape}>
            <Segments
              id="swing-tape"
              value={draft.tape}
              options={SWING_TAPES.map((value) => ({ value, label: TAPE_LABEL[value] }))}
              onChange={(tape) => onDraft({ ...draft, tape })}
            />
          </Cell>
        </div>
      </fieldset>

      <UniverseBuilder draft={draft} onDraft={onDraft} state={preview} problems={problems} />
    </>
  );
}
