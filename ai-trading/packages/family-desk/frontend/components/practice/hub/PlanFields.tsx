"use client";

import { Field, Input, NumberInput } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadFilters } from "@/lib/desk/screener";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { EARLIEST_START_DAY, MAX_FILTERS, MAX_LIST, MIN_LIST, toggleFilter, type PlanDraft, type PlanProblems } from "@/lib/replay/planSetup";
import { INTERVALS } from "@/lib/replay/setup";
import { runLabels } from "@/lib/spec/describe";
import styles from "./hub.module.css";
import modal from "./newplan.module.css";

/**
 * The setup half of the New thread modal (ADR-0025): her filters as one vertical column of checkboxes, which build the Screen at the thread's
 * time, then the start and the chart in one two-column grid (start date, start time, Screen size, chart interval). The parent owns the draft
 * and the start date (the recorded default only applies until she picks one). There is no fixed course length, no list time and no window: the
 * thread starts at one instant, 9:30 AM ET unless she picks another, and moves forward from it. Nothing is armed (D-076).
 */
export function PlanFields({
  draft,
  onDraft,
  problems,
  startDay,
  startDayNote,
  maxDay,
  onStartDay,
}: {
  draft: PlanDraft;
  onDraft: (draft: PlanDraft) => void;
  problems: PlanProblems;
  startDay: string;
  startDayNote: string | null;
  /** The last finished day: the newest start date the date box takes. */
  maxDay: string;
  onStartDay: (day: string) => void;
}) {
  const filters = useDeskQuery("practice:plan-filters", (signal) => loadFilters({ signal }));

  return (
    <>
      <fieldset className={modal.section} aria-describedby={problems.filters ? "plan-filters-error" : undefined}>
        <legend className={modal.legend}>{PRACTICE_COPY.planFilters}</legend>
        <p className={modal.help}>{practiceText("newThreadFiltersHint", { max: MAX_FILTERS })}</p>
        {filters.loading ? (
          <LoadingBlock label="Loading your filters…" height={64} />
        ) : filters.data === null ? (
          <ErrorBlock subject="filter list" onRetry={filters.refresh} />
        ) : filters.data.length === 0 ? (
          <p className={modal.help}>{PRACTICE_COPY.planFiltersEmpty}</p>
        ) : (
          <ul className={`${styles.armList} ${modal.filterList}`}>
            {filters.data.map((filter) => {
              const checked = draft.filterIds.includes(filter.id);
              const blocked = !checked && draft.filterIds.length >= MAX_FILTERS;
              return (
                <li key={filter.id}>
                  <label className={styles.armRow} data-disabled={blocked ? "true" : undefined}>
                    <input
                      type="checkbox"
                      className={styles.check}
                      checked={checked}
                      disabled={blocked}
                      onChange={() => onDraft({ ...draft, filterIds: toggleFilter(draft.filterIds, filter.id) })}
                    />
                    <span className={styles.armText}>
                      <span className={styles.armName}>{filter.name}</span>
                      <span className={styles.armRule}>{`At ${runLabels[filter.run_on]} during ${filter.session === "regular" ? "regular hours" : "extended hours"}`}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {problems.filters && <p id="plan-filters-error" role="alert" className={modal.fieldError}>{problems.filters}</p>}
      </fieldset>

      <fieldset className={modal.section}>
        <legend className={modal.legend}>{PRACTICE_COPY.newThreadSettings}</legend>
        <div className={modal.grid}>
          <Field id="plan-start-day" label={PRACTICE_COPY.newThreadStartDay} note={startDayNote ?? PRACTICE_COPY.newThreadStartNote} error={problems.startAt} testId="first-day-note" reserve>
            <Input type="date" value={startDay} min={EARLIEST_START_DAY} max={maxDay} onChange={(event) => onStartDay(event.target.value)} />
          </Field>
          <Field id="plan-start-time" label={PRACTICE_COPY.newThreadStartTime} reserve>
            <Input type="time" value={draft.startTime} onChange={(event) => onDraft({ ...draft, startTime: event.target.value })} />
          </Field>
          <Field id="plan-list-size" label={PRACTICE_COPY.newThreadListSize} error={problems.maxList}>
            <NumberInput fill inputMode="numeric" min={MIN_LIST} max={MAX_LIST} step={1} value={draft.maxList} onChange={(event) => onDraft({ ...draft, maxList: event.target.value })} />
          </Field>
          <Field id="plan-interval" label={PRACTICE_COPY.planInterval} group error={problems.interval}>
            <Segmented
              fill
              value={draft.interval}
              options={INTERVALS.map((interval) => ({ value: interval, label: interval }))}
              onChange={(interval) => onDraft({ ...draft, interval })}
            />
          </Field>
        </div>
      </fieldset>
    </>
  );
}
