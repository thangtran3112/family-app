"use client";

import { useMemo } from "react";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadFilters } from "@/lib/desk/screener";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { HUB_SWING_COPY } from "@/lib/replay/hubSwing";
import {
  EARLIEST_LIST_DAY,
  LIST_TIMES,
  MAX_FILTERS,
  NAME_CHOICES,
  SESSION_CHOICES,
  clock12,
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
import { ArmStrategiesField } from "./ArmStrategiesField";
import styles from "./hub.module.css";
import modal from "./landing.module.css";

/**
 * The daily-list half of the New plan modal (02r2, from the old daily-plan form): her filters as one vertical column of
 * checkboxes, the days, the list time and size, the window and the armed strategies. The parent owns the draft and the
 * first day (the recorded default only applies until she picks one). A filter she picks is armed for the practice days, and
 * the list time moves up for a cadence filter.
 */
export function DayPlanFields({
  draft,
  onDraft,
  problems,
  firstDay,
  firstDayNote,
  onFirstDay,
}: {
  draft: PlanDraft;
  onDraft: (draft: PlanDraft) => void;
  problems: PlanProblems;
  firstDay: string;
  firstDayNote: string | null;
  onFirstDay: (day: string) => void;
}) {
  const filters = useDeskQuery("practice:plan-filters", (signal) => loadFilters({ signal }));
  const timings: FilterTimings = useMemo(() => new Map((filters.data ?? []).map((filter) => [filter.id, { run_on: filter.run_on, session: filter.session }])), [filters.data]);
  // A cadence filter reads bars of the list day itself, so the list time cannot be earlier than its first bar.
  const need = listTimeNeed(draft.filterIds, timings);
  const needNames = (filters.data ?? []).filter((filter) => need.ids.includes(filter.id)).map((filter) => filter.name);
  const needText = practiceText("planListAtNeeds", { filters: needNames.join(" and "), time: clock12(need.time) });
  const setup = draft.setup;
  const patchSetup = (next: PlanDraft["setup"]) => onDraft({ ...draft, setup: next });

  return (
    <>
      <fieldset className={styles.group} aria-describedby={problems.filters ? "plan-filters-error" : undefined}>
        <legend className={styles.legend}>{PRACTICE_COPY.planFilters}</legend>
        <p className={styles.hint}>{practiceText("newPlanFiltersHint", { max: MAX_FILTERS })}</p>
        {filters.loading ? (
          <LoadingBlock label="Loading your filters…" height={64} />
        ) : filters.data === null ? (
          <ErrorBlock subject="filter list" onRetry={filters.refresh} />
        ) : filters.data.length === 0 ? (
          <p className={styles.hint}>{PRACTICE_COPY.planFiltersEmpty}</p>
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
                    <span className={styles.chip}>{HUB_SWING_COPY.filterOrigin[filter.origin]}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {problems.filters && <p id="plan-filters-error" role="alert" className={styles.fieldError}>{problems.filters}</p>}
      </fieldset>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>{PRACTICE_COPY.planStartDay}</span>
          <input
            type="date"
            className={styles.control}
            value={firstDay}
            min={EARLIEST_LIST_DAY}
            aria-invalid={problems.firstDay ? true : undefined}
            onChange={(event) => onFirstDay(event.target.value)}
          />
          {firstDayNote && <span className={styles.hint} data-testid="first-day-note">{firstDayNote}</span>}
          {problems.firstDay && <span role="alert" className={styles.fieldError}>{problems.firstDay}</span>}
        </label>
        <div className={styles.field}>
          <span id="plan-days-label" className={styles.label}>{PRACTICE_COPY.planDays}</span>
          <div role="group" aria-labelledby="plan-days-label" className={styles.segmented}>
            {SESSION_CHOICES.map((count) => (
              <button
                key={count}
                type="button"
                className={styles.segment}
                aria-pressed={draft.sessions === String(count)}
                onClick={() => onDraft({ ...draft, sessions: String(count) })}
              >
                {count}
              </button>
            ))}
          </div>
          {problems.sessions && <span role="alert" className={styles.fieldError}>{problems.sessions}</span>}
        </div>
        <div className={styles.field}>
          <span id="plan-names-label" className={styles.label}>{PRACTICE_COPY.planMaxSymbols}</span>
          <div role="group" aria-labelledby="plan-names-label" className={styles.segmented}>
            {NAME_CHOICES.map((count) => (
              <button
                key={count}
                type="button"
                className={styles.segment}
                aria-pressed={draft.maxSymbols === String(count)}
                onClick={() => onDraft({ ...draft, maxSymbols: String(count) })}
              >
                {count}
              </button>
            ))}
          </div>
          <span className={styles.hint}>{PRACTICE_COPY.planMaxSymbolsHint}</span>
          {problems.maxSymbols && <span role="alert" className={styles.fieldError}>{problems.maxSymbols}</span>}
        </div>
        <label className={styles.switch}>
          <input
            type="checkbox"
            role="switch"
            className={styles.check}
            checked={draft.hideDates}
            onChange={(event) => onDraft({ ...draft, hideDates: event.target.checked })}
          />
          {PRACTICE_COPY.planHideDates}
        </label>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <span id="plan-list-at-label" className={styles.label}>{PRACTICE_COPY.planListAt}</span>
          <div role="group" aria-labelledby="plan-list-at-label" className={styles.segmented}>
            {LIST_TIMES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={styles.segment}
                aria-pressed={draft.listAt === item.value}
                disabled={listTimeHeld(item.value, need)}
                title={listTimeHeld(item.value, need) ? needText : undefined}
                onClick={() => onDraft(withListTime(draft, item.value))}
              >
                {item.label}
              </button>
            ))}
          </div>
          {listTimeHeld(draft.listAt, need) && <span role="alert" className={styles.fieldError}>{needText}</span>}
          {problems.listAt && <span role="alert" className={styles.fieldError}>{problems.listAt}</span>}
        </div>
        <label className={styles.field}>
          <span className={styles.label}>{PRACTICE_COPY.planListSize}</span>
          <input
            type="number"
            inputMode="numeric"
            min={20}
            max={50}
            step={1}
            className={styles.control}
            value={draft.maxList}
            aria-invalid={problems.maxList ? true : undefined}
            onChange={(event) => onDraft({ ...draft, maxList: event.target.value })}
          />
          {problems.maxList && <span role="alert" className={styles.fieldError}>{problems.maxList}</span>}
        </label>
      </div>

      <fieldset className={styles.group} aria-describedby={problems.window ? "plan-window-error" : undefined}>
        <legend className={styles.legend}>Window (ET)</legend>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>From</span>
            <input type="time" className={styles.control} value={setup.from} onChange={(event) => patchSetup({ ...setup, from: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>To</span>
            <input type="time" className={styles.control} value={setup.to} onChange={(event) => patchSetup({ ...setup, to: event.target.value })} />
          </label>
          <div role="group" aria-label="Chart interval" className={styles.segmented}>
            {INTERVALS.map((interval) => (
              <button key={interval} type="button" className={styles.segment} aria-pressed={setup.interval === interval} onClick={() => patchSetup({ ...setup, interval })}>
                {interval}
              </button>
            ))}
          </div>
        </div>
        {problems.window && <p id="plan-window-error" role="alert" className={styles.fieldError}>{problems.window}</p>}
      </fieldset>

      <ArmStrategiesField armed={setup.armed} onChange={(armed) => patchSetup({ ...setup, armed })} error={problems.armed} />
    </>
  );
}
