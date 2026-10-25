import { PracticeBlockV1Schema } from "@ai-trading/contracts/practice-block-v1";
import type { DeskApiProblem } from "../api/client.ts";
import { defaultDraft, draftToSpec, fieldOfPath, type SetupDraft, type SetupField } from "./setup.ts";

// The hub's daily-list plan form (02o-b v1): the draft the form edits, its conversion to a `PracticeBlockV1`, and live
// validation against the contract's own Zod schema (the D6 pattern). The setup half reuses the single-session draft.

export const EARLIEST_LIST_DAY = "2017-01-03";
export const MAX_FILTERS = 3;
export const SESSION_CHOICES = [5, 10, 20, 30] as const;

/** The list times she is offered: the premarket gap list, the first 15 minutes, the first hour. */
export const LIST_TIMES = [
  { value: "08:30", label: "8:30 Premarket" },
  { value: "10:00", label: "10:00 After the first 15 minutes" },
  { value: "10:45", label: "10:45 After the first hour" },
] as const;

export type PlanDraft = {
  firstDay: string;
  sessions: string;
  hideDates: boolean;
  filterIds: number[];
  listAt: string;
  maxList: string;
  /** Window, session, interval, shares, armed and the plan fields; its symbol and day stay empty. */
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

export function defaultPlanDraft(now: Date): PlanDraft {
  const listAt = LIST_TIMES[0].value;
  return {
    firstDay: defaultFirstDay(now),
    sessions: "20",
    hideDates: true,
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

const numberOrNaN = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

/** The draft as the contract's JSON. Nothing is null or boolean; the optional plan fields are left out when empty. */
export function planDraftToSpec(draft: PlanDraft): unknown {
  const setup = draftToSpec(draft.setup) as Record<string, unknown>;
  return {
    schemaVersion: 1,
    firstDay: draft.firstDay,
    sessions: numberOrNaN(draft.sessions),
    hideDates: draft.hideDates ? "yes" : "no",
    screen: { filters: draft.filterIds.map((id) => ({ id })), listAt: draft.listAt, maxList: numberOrNaN(draft.maxList) },
    setup: { window: setup.window, session: setup.session, interval: setup.interval, shares: setup.shares, armed: setup.armed, plan: setup.plan },
  };
}

export type PlanField = SetupField | "firstDay" | "sessions" | "filters" | "listAt" | "maxList";
export type PlanProblems = Partial<Record<PlanField, string>>;

const FIELD_MESSAGE: Record<PlanField, string> = {
  symbol: "",
  day: "",
  window: "Pick a window that starts at or after the list time and ends after it starts",
  interval: "Pick 1m, 5m or 15m",
  shares: "Shares: a whole number from 1 to 10,000",
  armed: "Arm up to 5 strategies",
  stopRequired: "Pick yes or no",
  maxLossUsd: "Max loss: whole dollars from 1 to 100,000",
  maxTrades: "Max trades: a whole number from 1 to 50",
  note: "Plan note: up to 500 plain characters",
  form: "Check the plan and try again",
  firstDay: "Pick a weekday from Jan 3, 2017",
  sessions: "Days: a whole number from 5 to 30",
  filters: "Pick one to three filters",
  listAt: "List time: between 4:30 AM and 3:30 PM",
  maxList: "List size: a whole number from 20 to 50",
};

/** Maps a contract or server path (`screen.listAt`, `setup.plan.maxLossUsd`, `firstDay`) to the form field that shows it. */
export function planFieldOfPath(path: string): PlanField {
  const [first, second] = path.split(".");
  switch (first) {
    case "firstDay": case "sessions": return first;
    case "screen": return second === "filters" ? "filters" : second === "listAt" ? "listAt" : second === "maxList" ? "maxList" : "form";
    case "setup": return fieldOfPath(path.split(".").slice(1).join("."));
    case "window": return "window";
    case "plan": case "armed": case "shares": case "interval": return fieldOfPath(path);
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
