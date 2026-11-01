"use client";

import { useMemo } from "react";
import { Field, Input, NumberInput } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { formatClock } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadFilters } from "@/lib/desk/screener";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import {
  EARLIEST_LIST_DAY,
  LIST_TIMES,
  MAX_FILTERS,
  SESSION_CHOICES,
  listTimeHeld,
  listTimeNeed,
  withFilterToggled,
  withListTime,
  type FilterTimings,
  type PlanDraft,
  type PlanProblems,
} from "@/lib/replay/planSetup";
import { INTERVALS } from "@/lib/replay/setup";
import { runLabels } from "@/lib/spec/describe";
import styles from "./hub.module.css";
import modal from "./newplan.module.css";

/**
 * The daily-list half of the New plan modal (02r2, D-075, D-076): her filters as one vertical column of checkboxes, then the
 * settings in one two-column grid (first day, days, hide dates, list time, list size, interval, window). The
 * parent owns the draft and the first day (the recorded default only applies until she picks one). Nothing is armed (D-076),
 * and the list time moves up for a cadence filter.
 */
export function DayPlanFields({
  draft,
  onDraft,
  problems,
  firstDay,
  firstDayNote,
  maxDay,
  onFirstDay,
}: {
  draft: PlanDraft;
  onDraft: (draft: PlanDraft) => void;
  problems: PlanProblems;
  firstDay: string;
  firstDayNote: string | null;
  /** The last finished day: the newest first day the date box takes. */
  maxDay: string;
  onFirstDay: (day: string) => void;
}) {
  const filters = useDeskQuery("practice:plan-filters", (signal) => loadFilters({ signal }));
  const timings: FilterTimings = useMemo(() => new Map((filters.data ?? []).map((filter) => [filter.id, { run_on: filter.run_on, session: filter.session }])), [filters.data]);
  // A cadence filter reads bars of the list day itself, so the list time cannot be earlier than its first bar.
  const need = listTimeNeed(draft.filterIds, timings);
  const needNames = (filters.data ?? []).filter((filter) => need.ids.includes(filter.id)).map((filter) => filter.name);
  const needText = practiceText("planListAtNeeds", { filters: needNames.join(" and "), time: formatClock(need.time) });
  const anyHeld = LIST_TIMES.some((item) => listTimeHeld(item.value, need));
  const setup = draft.setup;
  const patchSetup = (next: PlanDraft["setup"]) => onDraft({ ...draft, setup: next });

  return (
    <>
      <fieldset className={modal.section} aria-describedby={problems.filters ? "plan-filters-error" : undefined}>
        <legend className={modal.legend}>{PRACTICE_COPY.planFilters}</legend>
        <p className={modal.help}>{practiceText("newPlanFiltersHint", { max: MAX_FILTERS })}</p>
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
                      onChange={() => onDraft(withFilterToggled(draft, filter.id, timings))}
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
        <legend className={modal.legend}>{PRACTICE_COPY.newPlanSettings}</legend>
        <div className={modal.grid}>
          <Field id="plan-first-day" label={PRACTICE_COPY.planStartDay} note={firstDayNote} error={problems.firstDay} testId="first-day-note" reserve>
            <Input type="date" value={firstDay} min={EARLIEST_LIST_DAY} max={maxDay} onChange={(event) => onFirstDay(event.target.value)} />
          </Field>
          <Field id="plan-days" label={PRACTICE_COPY.planDays} group error={problems.sessions}>
            <Segmented
              fill
              value={draft.sessions}
              options={SESSION_CHOICES.map((count) => ({ value: String(count), label: String(count) }))}
              onChange={(sessions) => onDraft({ ...draft, sessions })}
            />
          </Field>
          <Field id="plan-hide" label={PRACTICE_COPY.planHideDates} group className={modal.span} note={PRACTICE_COPY.planHideDatesHint}>
            <Segmented
              value={draft.hideDates ? "yes" : "no"}
              options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
              onChange={(value) => onDraft({ ...draft, hideDates: value === "yes" })}
            />
          </Field>
          <Field id="plan-list-at" label={PRACTICE_COPY.planListAt} group className={modal.span} note={anyHeld ? needText : PRACTICE_COPY.planListAtHint} error={problems.listAt} reserve>
            <Segmented
              fill
              value={draft.listAt}
              options={LIST_TIMES.map((item) => ({ value: item.value, label: item.label, ...(listTimeHeld(item.value, need) ? { disabledReason: needText, reasonId: "plan-list-at-note" } : {}) }))}
              onChange={(listAt) => onDraft(withListTime(draft, listAt))}
            />
          </Field>
          <Field id="plan-list-size" label={PRACTICE_COPY.planListSize} error={problems.maxList}>
            <NumberInput fill inputMode="numeric" min={20} max={50} step={1} value={draft.maxList} onChange={(event) => onDraft({ ...draft, maxList: event.target.value })} />
          </Field>
          <Field id="plan-interval" label={PRACTICE_COPY.planInterval} group>
            <Segmented
              fill
              value={setup.interval}
              options={INTERVALS.map((interval) => ({ value: interval, label: interval }))}
              onChange={(interval) => patchSetup({ ...setup, interval })}
            />
          </Field>
          <Field id="plan-from" label={PRACTICE_COPY.planWindowFrom} error={problems.window}>
            <Input type="time" value={setup.from} onChange={(event) => patchSetup({ ...setup, from: event.target.value })} />
          </Field>
          <Field id="plan-to" label={PRACTICE_COPY.planWindowTo}>
            <Input type="time" value={setup.to} aria-invalid={problems.window ? true : undefined} onChange={(event) => patchSetup({ ...setup, to: event.target.value })} />
          </Field>
        </div>
      </fieldset>
    </>
  );
}
