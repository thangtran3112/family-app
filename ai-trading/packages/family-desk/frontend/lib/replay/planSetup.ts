import { PracticeSetupV2Schema } from "@ai-trading/contracts/practice-setup-v2";
import type { DeskApiProblem } from "../api/client.ts";
import { PRACTICE_COPY } from "../desk/freshness.ts";
import { plainMessage } from "../desk/problems.ts";
import type { ReplayInterval } from "./schemas.ts";
import { dayProblem, EARLIEST_DAY, latestReplayDay } from "./setup.ts";
import { etWallToUtcIso } from "./time.ts";

// The New thread form's setup half (ADR-0025): the draft the form edits, its conversion to a `PracticeSetupV2`, and live validation
// against the contract's own Zod schema (the D6 pattern). A freestyle thread has one start instant, a Screen (her saved filters, scanned
// at the thread's clock) and the chart setup a lane opens with: no fixed course length, no list time, no window, no first date to count from.

export const EARLIEST_START_DAY = EARLIEST_DAY;
export const MAX_FILTERS = 3;
/** The regular open: where a thread starts unless she picks another time. */
export const DEFAULT_START_TIME = "09:30";
/** The extended session's bounds (ET): a start outside them is in no session at all. */
const SESSION_OPEN = "04:00";
const SESSION_CLOSE = "20:00";
export const MIN_LIST = 20;
export const MAX_LIST = 49;

export type PlanDraft = {
  /** An ET trading day, "YYYY-MM-DD". */
  startDay: string;
  /** ET wall time, "HH:MM". */
  startTime: string;
  /** The saved filters that build the Screen (one to three). */
  filterIds: number[];
  /** The Screen holds at most this many names (20 to 49). */
  maxList: string;
  interval: ReplayInterval;
};

/** The first weekday of the month three months back (New Year's Day rolls on): far enough back that she is unlikely to remember it. */
export function defaultStartDay(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1, 12));
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6 || (date.getUTCMonth() === 0 && date.getUTCDate() === 1)) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

/** The start date the form shows: the day she picked, else the server's default once the Desk has recorded 20 finished days of its
 *  universe (`GET /replay/universe-days`), else the draft's own (the first weekday three months back). */
export const effectiveStartDay = (draftDay: string, picked: boolean, recorded: string | null): string =>
  picked || recorded === null ? draftDay : recorded;

export function defaultPlanDraft(now: Date): PlanDraft {
  return { startDay: defaultStartDay(now), startTime: DEFAULT_START_TIME, filterIds: [], maxList: "30", interval: "5m" };
}

export function toggleFilter(ids: readonly number[], id: number): number[] {
  if (ids.includes(id)) return ids.filter((item) => item !== id);
  return ids.length >= MAX_FILTERS ? [...ids] : [...ids, id];
}

const numberOrNaN = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

/** The start instant the contract takes: an ISO time with an explicit offset, whole seconds ("2026-03-10T13:30:00Z"). "" for a day or time that is not one. */
export function startAtOf(day: string, time: string): string {
  const iso = etWallToUtcIso(day, time);
  return iso === null ? "" : iso.replace(/\.\d{3}Z$/, "Z");
}

/** The draft as the contract's JSON (`PracticeSetupV2`). Nothing is null or boolean; nothing is armed on a new thread (D-153), and the contract wants the field. */
export function planDraftToSetup(draft: PlanDraft): unknown {
  return {
    schemaVersion: 2,
    startAt: startAtOf(draft.startDay, draft.startTime),
    screen: { filters: draft.filterIds.map((id) => ({ id })), maxList: numberOrNaN(draft.maxList) },
    setup: { interval: draft.interval, session: "regular", armed: [] },
  };
}

export type PlanField = "startAt" | "filters" | "maxList" | "interval" | "form";
export type PlanProblems = Partial<Record<PlanField, string>>;

const FIELD_MESSAGE: Record<PlanField, string> = {
  startAt: "Pick a trading day and a time between 4:00 AM and 8:00 PM ET",
  filters: "Pick one to three filters",
  maxList: `Screen size: a whole number from ${MIN_LIST} to ${MAX_LIST}`,
  interval: "Pick 1m, 5m or 15m",
  form: "Check the thread and try again",
};

/** Maps a contract or server path (`startAt`, `screen.filters`, `setup.startAt`) to the form field that shows it. */
export function planFieldOfPath(path: string): PlanField {
  const parts = path.split(".");
  if (parts.includes("startAt")) return "startAt";
  if (parts.includes("filters")) return "filters";
  if (parts.includes("maxList")) return "maxList";
  if (parts.includes("interval")) return "interval";
  return "form";
}

export function planProblems(problems: readonly DeskApiProblem[]): PlanProblems {
  const result: PlanProblems = {};
  for (const problem of problems) {
    const field = planFieldOfPath(problem.path);
    result[field] ??= problem.message ? plainMessage(problem.message, problem.path) : FIELD_MESSAGE[field];
  }
  return result;
}

export type PlanValidation = { ok: true; spec: ReturnType<typeof PracticeSetupV2Schema.parse> } | { ok: false; problems: PlanProblems };

/** Live validation: the contract's Zod schema plus a local read of the start date and time. With `now`, a day that has not finished is a
 *  problem too. Holidays, one-off closures and the data horizon are the server's call. */
export function validatePlanDraft(draft: PlanDraft, now?: Date): PlanValidation {
  const problems: PlanProblems = {};
  const day = now === undefined ? null : dayProblem(draft.startDay, now);
  if (day !== null) problems.startAt = day;
  else if (draft.startDay === "" || startAtOf(draft.startDay, draft.startTime) === "") problems.startAt = FIELD_MESSAGE.startAt;
  else if (draft.startTime < SESSION_OPEN || draft.startTime > SESSION_CLOSE) problems.startAt = FIELD_MESSAGE.startAt;
  const parsed = PracticeSetupV2Schema.safeParse(planDraftToSetup(draft));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = planFieldOfPath(issue.path.join("."));
      problems[field] ??= issue.code === "custom" ? plainMessage(issue.message, issue.path.join(".")) : FIELD_MESSAGE[field];
    }
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return parsed.success ? { ok: true, spec: parsed.data } : { ok: false, problems: { form: FIELD_MESSAGE.form } };
}

/** What the form shows while she edits: every problem except the missing filter (the footer already says it) and the catch-all. */
export function livePlanProblems(draft: PlanDraft, now: Date): PlanProblems {
  const result = validatePlanDraft(draft, now);
  if (result.ok) return {};
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the two fields only the submit shows are left out
  const { filters: _filters, form: _form, ...rest } = result.problems;
  return rest;
}

/** The newest start date the date box takes: the last finished session. */
export const latestStartDay = latestReplayDay;

/** The one button of the modal. */
export const startLabel = (): string => PRACTICE_COPY.newPlanStartThread;
