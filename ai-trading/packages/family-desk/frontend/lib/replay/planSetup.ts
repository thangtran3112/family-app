import { PracticeBlockV1Schema } from "@ai-trading/contracts/practice-block-v1";
import type { DeskApiProblem } from "../api/client.ts";
import { MAX_ARMED, defaultDraft, draftToSpec, fieldOfPath, type ArmedRef, type SetupDraft, type SetupField } from "./setup.ts";

// The hub's daily-list plan form (02o-b v1): the draft the form edits, its conversion to a `PracticeBlockV1`, and live
// validation against the contract's own Zod schema (the D6 pattern). The setup half reuses the single-session draft.

export const EARLIEST_LIST_DAY = "2017-01-03";
export const MAX_FILTERS = 3;
export const SESSION_CHOICES = [5, 10, 20, 30] as const;
/** The names a day she can choose (the contract's `maxSymbols`, 1 to 5); a new plan starts at 3. */
export const NAME_CHOICES = [1, 2, 3, 4, 5] as const;
export const DEFAULT_MAX_SYMBOLS = 3;

/** The list times she is offered: the premarket gap list, the first 15 minutes, the first hour. */
export const LIST_TIMES = [
  { value: "08:30", label: "8:30 Premarket" },
  { value: "10:00", label: "10:00 After the first 15 minutes" },
  { value: "10:45", label: "10:45 After the first hour" },
] as const;

/** What the filter list carries about a filter's cadence: enough to know when its first bar of the list day exists. */
export type FilterTiming = { run_on: string; session: "regular" | "extended" };

const CADENCE_MINUTES: Record<string, number> = { bar_close_1m: 1, bar_close_5m: 5, bar_close_15m: 15, bar_close_1h: 60 };
/** The live SIP embargo the list's data lags by (backend `LIST_DATA_LAG`). */
const LIST_LAG_MINUTES = 15;
const EARLIEST_LIST_AT = "04:30";

/** The earliest list time ("HH:MM" ET) at which the filter reads a bar of the list day itself; the server answers 422
 *  below it. A mirror of `earliest_list_at` in `replay/screen.py`: the two tables are tested against the same values. */
export function earliestListAt(filter: FilterTiming): string {
  if (filter.run_on === "premarket_0830") return "08:30";
  const cadence = CADENCE_MINUTES[filter.run_on];
  if (cadence === undefined) return EARLIEST_LIST_AT; // daily_close and weekly read the sessions before the day
  const minutes = (filter.session === "regular" ? 9 * 60 + 30 : 4 * 60) + cadence + LIST_LAG_MINUTES;
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** "10:00" as "10:00 AM". */
export function clock12(hhmm: string): string {
  const [hours, minutes] = hhmm.split(":").map(Number) as [number, number];
  return `${hours % 12 || 12}:${pad(minutes)} ${hours < 12 ? "AM" : "PM"}`;
}

export type FilterTimings = ReadonlyMap<number, FilterTiming>;

/** The latest of the chosen filters' earliest list times, and the filters that set it. */
export function listTimeNeed(filterIds: readonly number[], timings: FilterTimings): { time: string; ids: number[] } {
  let time = EARLIEST_LIST_AT;
  let ids: number[] = [];
  for (const id of filterIds) {
    const timing = timings.get(id);
    if (timing === undefined) continue;
    const need = earliestListAt(timing);
    if (need > time) [time, ids] = [need, [id]];
    else if (need === time && need > EARLIEST_LIST_AT) ids.push(id);
  }
  return { time, ids };
}

/** True when `time` is earlier than the chosen filters need: that list time is off and the server would answer 422. A time
 *  at or after the need holds, so nothing is said about it (D-017: the "needs a list time" line used to show whenever a
 *  cadence filter was picked, even with a good time selected). */
export const listTimeHeld = (time: string, need: { time: string; ids: readonly number[] }): boolean => need.ids.length > 0 && time < need.time;

export type PlanDraft = {
  firstDay: string;
  sessions: string;
  hideDates: boolean;
  /** The most names she may star and practise in a day. */
  maxSymbols: string;
  filterIds: number[];
  listAt: string;
  maxList: string;
  /** Window, session, interval and armed; the symbol, day, shares and risk plan are not the daily plan's (D-007). */
  setup: SetupDraft;
};

const pad = (value: number) => String(value).padStart(2, "0");

/** Two hours from the list time, never before the open, never past the close. */
export function windowForList(listAt: string): { from: string; to: string } {
  const from = listAt < "09:30" ? "09:30" : listAt;
  const [hours, minutes] = from.split(":").map(Number) as [number, number];
  const end = Math.min(hours * 60 + minutes + 120, 16 * 60);
  return { from, to: `${pad(Math.floor(end / 60))}:${pad(end % 60)}` };
}

/** The first weekday of the month three months back (New Year's Day rolls on): far enough back that she is unlikely to remember it. */
export function defaultFirstDay(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1, 12));
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6 || (date.getUTCMonth() === 0 && date.getUTCDate() === 1)) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

/** The first day the form shows: the day she picked, else the server's default once the Desk has recorded 20 finished days of
 *  its universe (`GET /replay/universe-days`), else the draft's own (the first weekday three months back). */
export const effectiveFirstDay = (draftDay: string, picked: boolean, recorded: string | null): string =>
  picked || recorded === null ? draftDay : recorded;

export function defaultPlanDraft(now: Date): PlanDraft {
  const listAt = LIST_TIMES[0].value;
  return {
    firstDay: defaultFirstDay(now),
    sessions: "20",
    hideDates: true,
    maxSymbols: String(DEFAULT_MAX_SYMBOLS),
    filterIds: [],
    listAt,
    maxList: "30",
    setup: { ...defaultDraft(), ...windowForList(listAt) },
  };
}

/** Picking a list time moves the window start to it (a window cannot begin before the list). */
export function withListTime(draft: PlanDraft, listAt: string): PlanDraft {
  const window = windowForList(listAt);
  return { ...draft, listAt, setup: { ...draft.setup, from: window.from, to: draft.setup.to > window.from ? draft.setup.to : window.to } };
}

export function toggleFilter(ids: readonly number[], id: number): number[] {
  if (ids.includes(id)) return ids.filter((item) => item !== id);
  return ids.length >= MAX_FILTERS ? [...ids] : [...ids, id];
}

/** The first offered list time at or after `need` (the last one when none is late enough). */
export function listTimeFrom(need: string): string {
  return (LIST_TIMES.find((item) => item.value >= need) ?? LIST_TIMES[LIST_TIMES.length - 1]).value;
}

/** Picks or drops a filter. A picked filter is armed for the practice days (arming is what releases its would-fire
 *  signals while she replays), a dropped one is disarmed, and a list time too early for a cadence filter moves to the
 *  first offered time that works (10:00 for a 15-minute filter). */
export function withFilterToggled(draft: PlanDraft, id: number, timings: FilterTimings): PlanDraft {
  const filterIds = toggleFilter(draft.filterIds, id);
  if (filterIds.length === draft.filterIds.length && filterIds.every((item, index) => item === draft.filterIds[index])) return draft;
  const ref: ArmedRef = { source: "filter", id };
  const armed = filterIds.includes(id)
    ? draft.setup.armed.some((item) => item.source === "filter" && item.id === id) || draft.setup.armed.length >= MAX_ARMED
      ? draft.setup.armed
      : [...draft.setup.armed, ref]
    : draft.setup.armed.filter((item) => !(item.source === "filter" && item.id === id));
  const next = { ...draft, filterIds, setup: { ...draft.setup, armed } };
  const need = listTimeNeed(filterIds, timings).time;
  return next.listAt < need ? withListTime(next, listTimeFrom(need)) : next;
}

const numberOrNaN = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

/** The draft as the contract's JSON. Nothing is null or boolean. The block carries no shares and no risk plan: the thread has the plan (D-007). */
export function planDraftToSpec(draft: PlanDraft): unknown {
  const setup = draftToSpec(draft.setup) as Record<string, unknown>;
  return {
    schemaVersion: 1,
    firstDay: draft.firstDay,
    sessions: numberOrNaN(draft.sessions),
    hideDates: draft.hideDates ? "yes" : "no",
    maxSymbols: numberOrNaN(draft.maxSymbols),
    screen: { filters: draft.filterIds.map((id) => ({ id })), listAt: draft.listAt, maxList: numberOrNaN(draft.maxList) },
    setup: { window: setup.window, session: setup.session, interval: setup.interval, armed: setup.armed },
  };
}

export type PlanField = SetupField | "firstDay" | "sessions" | "filters" | "listAt" | "maxList" | "maxSymbols";
export type PlanProblems = Partial<Record<PlanField, string>>;

const FIELD_MESSAGE: Record<PlanField, string> = {
  symbol: "",
  day: "",
  window: "Pick a window that starts at or after the list time and ends after it starts",
  interval: "Pick 1m, 5m or 15m",
  armed: "Arm up to 5 strategies",
  form: "Check the plan and try again",
  firstDay: "Pick a weekday from Jan 3, 2017",
  sessions: "Days: a whole number from 5 to 30",
  filters: "Pick one to three filters",
  listAt: "List time: between 4:30 AM and 3:30 PM",
  maxList: "List size: a whole number from 20 to 50",
  maxSymbols: "Names a day: a whole number from 1 to 5",
};

/** Maps a contract or server path (`screen.listAt`, `setup.window.from`, `firstDay`) to the form field that shows it. */
export function planFieldOfPath(path: string): PlanField {
  const [first, second] = path.split(".");
  switch (first) {
    case "firstDay": case "sessions": case "maxSymbols": return first;
    case "screen": return second === "filters" ? "filters" : second === "listAt" ? "listAt" : second === "maxList" ? "maxList" : "form";
    case "setup": return fieldOfPath(path.split(".").slice(1).join("."));
    case "window": return "window";
    case "armed": case "interval": return fieldOfPath(path);
    default: return "form";
  }
}

export function planProblems(problems: readonly DeskApiProblem[]): PlanProblems {
  const result: PlanProblems = {};
  for (const problem of problems) {
    const field = planFieldOfPath(problem.path);
    result[field] ??= problem.message || FIELD_MESSAGE[field];
  }
  return result;
}

export type PlanValidation = { ok: true; spec: ReturnType<typeof PracticeBlockV1Schema.parse> } | { ok: false; problems: PlanProblems };

const isWeekend = (day: string) => {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
};

/** Live validation: the contract's Zod schema plus a local read of the first day. Holidays and unfinished days are the server's call. */
export function validatePlanDraft(draft: PlanDraft): PlanValidation {
  const problems: PlanProblems = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.firstDay) || Number.isNaN(Date.parse(`${draft.firstDay}T12:00:00Z`)) || draft.firstDay < EARLIEST_LIST_DAY || isWeekend(draft.firstDay)) {
    problems.firstDay = FIELD_MESSAGE.firstDay;
  }
  const parsed = PracticeBlockV1Schema.safeParse(planDraftToSpec(draft));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = planFieldOfPath(issue.path.join("."));
      problems[field] ??= issue.code === "custom" ? issue.message : FIELD_MESSAGE[field];
    }
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return parsed.success ? { ok: true, spec: parsed.data } : { ok: false, problems: { form: FIELD_MESSAGE.form } };
}
