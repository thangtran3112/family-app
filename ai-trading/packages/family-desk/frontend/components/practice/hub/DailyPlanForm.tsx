"use client";

import { useMemo, useState } from "react";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { openNextDay } from "@/lib/desk/replay";
import { loadFilters } from "@/lib/desk/screener";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import type { OpenNext } from "@/lib/replay/daily";
import type { PracticeThread } from "@/lib/replay/threads";
import {
  EARLIEST_LIST_DAY,
  LIST_TIMES,
  MAX_FILTERS,
  SESSION_CHOICES,
  clock12,
  defaultPlanDraft,
  listTimeNeed,
  planProblems,
  validatePlanDraft,
  withFilterToggled,
  withListTime,
  type FilterTimings,
  type PlanDraft,
  type PlanProblems,
} from "@/lib/replay/planSetup";
import { INTERVALS } from "@/lib/replay/setup";
import { ArmStrategiesField } from "./ArmStrategiesField";
import styles from "./hub.module.css";

/** The daily-list plan (02o-b v1): her filters, when the list is built, how many days, and the practice setup that
 *  every day shares. "Start day" saves it (replacing a current plan), starts preparing the data and, when that is ready,
 *  opens Day 1. A filter she picks is armed for the practice days; the list time moves up for a cadence filter. The
 *  risk plan (stop, signal, max loss, max trades, note) is the thread's (02r, D-007) and is not asked here. */
export function DailyPlanForm({ thread, onSaved, onCancel }: { thread: PracticeThread; onSaved: (result: OpenNext) => void; onCancel?: () => void }) {
  const [draft, setDraft] = useState<PlanDraft>(() => defaultPlanDraft(new Date()));
  const [problems, setProblems] = useState<PlanProblems>({});
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const filters = useDeskQuery("practice:plan-filters", (signal) => loadFilters({ signal }));
  const timings: FilterTimings = useMemo(() => new Map((filters.data ?? []).map((filter) => [filter.id, { run_on: filter.run_on, session: filter.session }])), [filters.data]);
  // A cadence filter reads bars of the list day itself, so the list time cannot be earlier than its first bar.
  const need = listTimeNeed(draft.filterIds, timings);
  const needNames = (filters.data ?? []).filter((filter) => need.ids.includes(filter.id)).map((filter) => filter.name);

  async function save() {
    const result = validatePlanDraft(draft);
    if (!result.ok) {
      setProblems(result.problems);
      return;
    }
    setProblems({});
    setFailed(false);
    setSubmitting(true);
    try {
      onSaved(await openNextDay(result.spec, { threadId: thread.id }));
    } catch (error) {
      if (error instanceof DeskApiError && error.status === 422 && error.problems.length > 0) setProblems(planProblems(error.problems));
      else setFailed(true);
      setSubmitting(false);
    }
  }

  const setup = draft.setup;
  const patchSetup = (next: PlanDraft["setup"]) => setDraft({ ...draft, setup: next });

  return (
    <form
      className={styles.form}
      noValidate
      aria-label="Daily list plan"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className={styles.muted}>{PRACTICE_COPY.planIntro}</p>
      {onCancel && <p className={styles.muted}>{PRACTICE_COPY.planReplace}</p>}

      <fieldset className={styles.group} aria-describedby={problems.filters ? "plan-filters-error" : undefined}>
        <legend className={styles.legend}>{PRACTICE_COPY.planFilters}</legend>
        {filters.loading ? (
          <LoadingBlock label="Loading your filters…" height={64} />
        ) : filters.data === null ? (
          <ErrorBlock subject="filter list" onRetry={filters.refresh} />
        ) : filters.data.length === 0 ? (
          <p className={styles.hint}>{PRACTICE_COPY.planFiltersEmpty}</p>
        ) : (
          <ul className={styles.armList}>
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
                      onChange={() => setDraft(withFilterToggled(draft, filter.id, timings))}
                    />
                    <span className={styles.armText}>
                      <span className={styles.armName}>{filter.name}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <p className={styles.hint}>{PRACTICE_COPY.planFiltersMax}</p>
        {problems.filters && <p id="plan-filters-error" role="alert" className={styles.fieldError}>{problems.filters}</p>}
      </fieldset>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>{PRACTICE_COPY.planStartDay}</span>
          <input
            type="date"
            className={styles.control}
            value={draft.firstDay}
            min={EARLIEST_LIST_DAY}
            aria-invalid={problems.firstDay ? true : undefined}
            onChange={(event) => setDraft({ ...draft, firstDay: event.target.value })}
          />
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
                onClick={() => setDraft({ ...draft, sessions: String(count) })}
              >
                {count}
              </button>
            ))}
          </div>
          {problems.sessions && <span role="alert" className={styles.fieldError}>{problems.sessions}</span>}
        </div>
        <label className={styles.switch}>
          <input
            type="checkbox"
            role="switch"
            className={styles.check}
            checked={draft.hideDates}
            onChange={(event) => setDraft({ ...draft, hideDates: event.target.checked })}
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
                disabled={item.value < need.time}
                onClick={() => setDraft(withListTime(draft, item.value))}
              >
                {item.label}
              </button>
            ))}
          </div>
          {need.ids.length > 0 && (
            <span className={styles.hint}>{practiceText("planListAtNeeds", { filters: needNames.join(" and "), time: clock12(need.time) })}</span>
          )}
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
            onChange={(event) => setDraft({ ...draft, maxList: event.target.value })}
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

      {problems.form && <p role="alert" className={styles.fieldError}>{problems.form}</p>}
      {failed && <ErrorBlock message={PRACTICE_COPY.planStartError} onRetry={() => void save()} />}
      <div className={styles.actions}>
        <span className={`${styles.hint} ${styles.actionNote}`}>{PRACTICE_COPY.threadPlanFrom}</span>
        {onCancel && <button type="button" className={styles.button} onClick={onCancel}>Cancel</button>}
        <button type="submit" className={styles.primary} disabled={submitting}>{PRACTICE_COPY.planSubmit}</button>
      </div>
    </form>
  );
}
