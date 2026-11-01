import { PracticeThreadCreateV1Schema } from "@ai-trading/contracts/practice-thread-v1";
import { formatEtDay } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { lastWeekday, latestReplayDay } from "./setup.ts";
import type { SwingPreviewRequest, UniverseRow } from "./swingApi.ts";
import { threadDraftToSpec, threadFieldOfPath, validateThreadDraft, type ThreadDraft, type ThreadField } from "./threadSetup.ts";
import { MAX_FILTERS, MAX_UNIVERSE, MIN_UNIVERSE, MAX_WATCHLISTS, noEdits, parseTarget, toggleId, universeEntries, type UniverseEdits } from "./universeView.ts";

// The Swing section of the New thread form (02p c1): the draft the form edits, the preview request and the
// `PracticeThreadCreateV1` body built from it, and live validation against the contract's own Zod schema (the D6
// pattern) with field-level messages in plain words. The thread half (starting balance, risk plan) stays the 02r
// `ThreadDraft`; in a swing thread the plan's max loss and max trades count per week, and the form says so.

export const MIN_SESSIONS = 15;
export const MAX_SESSIONS = 23;
export const DEFAULT_SESSIONS = 20;
/** `screen.EARLIEST_LIST_DAY`: a 52-week filter needs history before the first day. */
export const EARLIEST_SWING_DAY = "2017-01-03";
/** The interval choices of a swing session (the chart also offers Daily; that is a display switch, not an interval). */
export const SWING_INTERVALS = ["15m", "5m"] as const;
export const SWING_TAPES = ["off", "on"] as const;
/** Cadences that read daily bars: only these filters can be armed on a swing thread (the board is the prior evening). */
export const DAILY_RUN_ON: readonly string[] = ["daily_close", "weekly"];

export const isDailyRunOn = (runOn: string): boolean => DAILY_RUN_ON.includes(runOn);

export type SwingDraft = {
  /** "YYYY-MM-DD" of a Monday-to-Friday session. */
  firstDay: string;
  /** Whole sessions as typed, 15 to 23. */
  sessions: string;
  hideDates: boolean;
  interval: (typeof SWING_INTERVALS)[number];
  tape: (typeof SWING_TAPES)[number];
  /** Whole dollars as typed; empty means no per-hold risk. */
  riskPerHoldUsd: string;
  // The universe builder's inputs (they feed the preview, not the contract).
  watchlistIds: number[];
  filterIds: number[];
  fill: "liquidity" | "none";
  /** Target size as typed, 10 to 50. */
  target: string;
  edits: UniverseEdits;
};

const pad = (value: number) => String(value).padStart(2, "0");
const isoOf = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const noon = (day: string) => new Date(`${day}T12:00:00Z`);

/**
 * A Monday that is a market holiday: the four holidays that fall on a fixed Monday of the month (MLK Day, Presidents Day,
 * Memorial Day, Labor Day) and a fixed-date holiday kept on that Monday (New Year's, Juneteenth, July 4, Christmas, also
 * when it falls on the Sunday before). One-off closures are the server's call.
 */
export function isMondayHoliday(date: Date): boolean {
  if (date.getUTCDay() !== 1) return false;
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  switch (month) {
    case 0: return day === 1 || day === 2 || (day >= 15 && day <= 21);
    case 1: return day >= 15 && day <= 21;
    case 4: return day >= 25;
    case 5: return day === 19 || day === 20;
    case 6: return day === 4 || day === 5;
    case 8: return day <= 7;
    case 11: return day === 25 || day === 26;
    default: return false;
  }
}

/** The Monday session about three months back: far enough that she is unlikely to remember it. A holiday Monday rolls to Tuesday. */
export function defaultSwingFirstDay(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, now.getUTCDate(), 12));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (isMondayHoliday(date)) date.setUTCDate(date.getUTCDate() + 1);
  return isoOf(date);
}

export const defaultSwingDraft = (now: Date): SwingDraft => ({
  firstDay: defaultSwingFirstDay(now),
  sessions: String(DEFAULT_SESSIONS),
  hideDates: true,
  interval: "15m",
  tape: "off",
  riskPerHoldUsd: "",
  watchlistIds: [],
  filterIds: [],
  fill: "liquidity",
  target: String(MAX_UNIVERSE),
  edits: noEdits(),
});

const numberOrNaN = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text.replaceAll(",", "")));

export const toggleWatchlist = (ids: readonly number[], id: number): number[] => toggleId(ids, id, MAX_WATCHLISTS);
export const toggleFillFilter = (ids: readonly number[], id: number): number[] => toggleId(ids, id, MAX_FILTERS);

// -- the calendar line -------------------------------------------------------------------------------------------

const weekdayOffset = (day: string): number => {
  const date = noon(day);
  return Number.isNaN(date.getTime()) ? 0 : Math.min((date.getUTCDay() + 6) % 7, 4);
};

/**
 * "20 sessions · 4 weeks · ends on day 20". The weeks are the calendar weeks the sessions touch, counted from the first
 * day's weekday; a market holiday inside the range can add one more, which the thread page then shows.
 * ponytail: holidays inside the range are not modeled here; the created thread reports its real week count.
 */
export function calendarLine(draft: Pick<SwingDraft, "firstDay" | "sessions">): string | null {
  const sessions = numberOrNaN(draft.sessions);
  if (!Number.isInteger(sessions) || sessions < MIN_SESSIONS || sessions > MAX_SESSIONS) return null;
  const weeks = Math.ceil((weekdayOffset(draft.firstDay) + sessions) / 5);
  return practiceText("swingCalendarLine", { sessions, weeks, noun: weeks === 1 ? "week" : "weeks" });
}

// -- validation --------------------------------------------------------------------------------------------------

export type SwingField =
  | "firstDay" | "sessions" | "hideDates" | "universe" | "interval" | "tape" | "armed" | "riskPerHoldUsd" | "target";
export type SwingFormField = ThreadField | SwingField;
export type SwingProblems = Partial<Record<SwingFormField, string>>;

const FIELD_MESSAGE: Record<SwingField, string> = {
  firstDay: "First day: pick a weekday from Jan 3, 2017",
  sessions: `Sessions: a whole number from ${MIN_SESSIONS} to ${MAX_SESSIONS}`,
  hideDates: "Pick yes or no",
  universe: `Universe: ${MIN_UNIVERSE} to ${MAX_UNIVERSE} symbols, each once`,
  interval: "Interval: pick 15m or 5m",
  tape: "Tape: pick off or on",
  armed: "Arm up to 5 strategies",
  riskPerHoldUsd: "Risk per hold: whole dollars from 1 to 100,000",
  target: `Target size: a whole number from ${MIN_UNIVERSE} to ${MAX_UNIVERSE}`,
};

const SWING_FIELDS: ReadonlySet<string> = new Set<SwingField>(["firstDay", "sessions", "hideDates", "universe", "interval", "tape", "armed", "riskPerHoldUsd", "target"]);

/** Maps a contract or server path (`swing.universe.3.symbol`, `swing.armed.0.id`, `swing.firstDay`) to the field that shows it. */
export function swingFieldOfPath(path: string): SwingField | "form" {
  const [first, second] = path.split(".");
  if (first !== "swing") return "form";
  return second !== undefined && SWING_FIELDS.has(second) ? (second as SwingField) : "form";
}

const PREVIEW_PATHS: Record<string, SwingField> = { first_day: "firstDay", sessions: "sessions", target: "target", fill: "universe", watchlist_ids: "universe", filter_ids: "universe", add: "universe", remove: "universe" };

/**
 * Server `422` problems of the preview or the create to per-field messages; the server's sentences are plain and shown as
 * they are. The preview posts bare names (`first_day`, `add.2`), the create the nested contract (`swing.firstDay`,
 * `plan.maxLossUsd`).
 */
export function swingProblems(problems: ReadonlyArray<{ path: string; message: string }>): SwingProblems {
  const result: SwingProblems = {};
  for (const problem of problems) {
    const head = problem.path.split(".")[0] ?? "";
    const field: SwingFormField = head === "swing" ? swingFieldOfPath(problem.path) : (PREVIEW_PATHS[head] ?? threadFieldOfPath(problem.path));
    result[field] ??= problem.message || (field in FIELD_MESSAGE ? FIELD_MESSAGE[field as SwingField] : PRACTICE_COPY.swingFormError);
  }
  return result;
}

const isoDay = /^\d{4}-\d{2}-\d{2}$/;

/** A quick local read of the first day and the range; holidays and missing data are the server's call (its 422 shows inline). */
export function firstDayProblem(draft: Pick<SwingDraft, "firstDay" | "sessions">, now: Date): string | null {
  const { firstDay } = draft;
  if (!isoDay.test(firstDay) || Number.isNaN(noon(firstDay).getTime()) || firstDay < EARLIEST_SWING_DAY) return FIELD_MESSAGE.firstDay;
  const weekday = noon(firstDay).getUTCDay();
  if (weekday === 0 || weekday === 6) return practiceText("noTrading", { day: formatEtDay(firstDay) });
  const sessions = numberOrNaN(draft.sessions);
  if (Number.isInteger(sessions) && sessions >= MIN_SESSIONS && sessions <= MAX_SESSIONS && lastWeekday(firstDay, sessions) > latestReplayDay(now)) {
    return practiceText("swingRangeTooLate", { sessions, day: formatEtDay(firstDay) });
  }
  return null;
}

/** The target size box: a whole number from 10 to 50, or empty (50). */
export function targetProblem(text: string): string | null {
  if (text.trim() === "") return null;
  const value = numberOrNaN(text);
  return Number.isInteger(value) && value >= MIN_UNIVERSE && value <= MAX_UNIVERSE ? null : FIELD_MESSAGE.target;
}

/** Problems that stop a preview call: the first day, the sessions and the target. Empty means the table can be built. */
export function previewProblems(draft: SwingDraft, now: Date): SwingProblems {
  const problems: SwingProblems = {};
  const sessions = numberOrNaN(draft.sessions);
  if (!Number.isInteger(sessions) || sessions < MIN_SESSIONS || sessions > MAX_SESSIONS) problems.sessions = FIELD_MESSAGE.sessions;
  const day = firstDayProblem(draft, now);
  if (day) problems.firstDay = day;
  const target = targetProblem(draft.target);
  if (target) problems.target = target;
  return problems;
}

// -- the preview request and the create body -----------------------------------------------------------------------

/** The body of `POST /replay/threads/swing-universe`. Call only when `previewProblems` is empty. */
export function previewRequest(draft: SwingDraft): SwingPreviewRequest {
  return {
    first_day: draft.firstDay,
    sessions: numberOrNaN(draft.sessions),
    watchlist_ids: [...draft.watchlistIds],
    filter_ids: [...draft.filterIds],
    fill: draft.fill,
    add: [...draft.edits.add],
    remove: [...draft.edits.remove],
    target: parseTarget(draft.target),
  };
}

/** A stable key of the request, so the form re-previews only when something that matters changed. */
export const previewKey = (request: SwingPreviewRequest): string => JSON.stringify(request);

/** The `swing` block of the contract. The universe is the preview's rows, in fill order, each with its source tag. */
export function swingBlock(draft: SwingDraft, rows: readonly Pick<UniverseRow, "symbol" | "source">[]): Record<string, unknown> {
  const block: Record<string, unknown> = {
    firstDay: draft.firstDay,
    sessions: numberOrNaN(draft.sessions),
    hideDates: draft.hideDates ? "yes" : "no",
    universe: universeEntries(rows),
    interval: draft.interval,
    tape: draft.tape,
    armed: [], // a new swing thread starts with nothing armed (D-153): the contract wants the field, the form no longer offers it
  };
  if (draft.riskPerHoldUsd.trim() !== "") block.riskPerHoldUsd = numberOrNaN(draft.riskPerHoldUsd);
  return block;
}

/** The whole `PracticeThreadCreateV1` body: the thread half from the 02r draft (mode forced to swing) plus the swing block. */
export const swingCreateBody = (thread: ThreadDraft, draft: SwingDraft, rows: readonly Pick<UniverseRow, "symbol" | "source">[]): unknown => ({
  ...(threadDraftToSpec({ ...thread, mode: "swing" }) as Record<string, unknown>),
  swing: swingBlock(draft, rows),
});

export type SwingValidation =
  | { ok: true; spec: ReturnType<typeof PracticeThreadCreateV1Schema.parse> }
  | { ok: false; problems: SwingProblems };

/**
 * Live validation of the whole New swing thread form: the thread half through the day form's own validation (balance and
 * plan rules), the swing block through the contract's Zod schema, and a local read of the first day and the range.
 */
export function validateSwingDraft(thread: ThreadDraft, draft: SwingDraft, rows: readonly Pick<UniverseRow, "symbol" | "source">[], now: Date): SwingValidation {
  const problems: SwingProblems = {};
  const half = validateThreadDraft({ ...thread, mode: "day" });
  if (!half.ok) Object.assign(problems, half.problems);
  const local = previewProblems(draft, now);
  if (local.firstDay) problems.firstDay = local.firstDay;
  const parsed = PracticeThreadCreateV1Schema.safeParse(swingCreateBody(thread, draft, rows));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join(".");
      const field = swingFieldOfPath(path);
      if (field === "form") continue; // the thread half was read above
      problems[field] ??= issue.code === "custom" ? issue.message : FIELD_MESSAGE[field];
    }
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return parsed.success ? { ok: true, spec: parsed.data } : { ok: false, problems: { form: PRACTICE_COPY.swingFormError } };
}
