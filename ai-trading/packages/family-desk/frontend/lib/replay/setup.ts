import { ReplaySessionV1Schema } from "@ai-trading/contracts/replay-session-v1";
import { DeskApiError, type DeskApiProblem } from "../api/client.ts";
import { formatEtDay } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import type { ReplayDay, ReplayInterval } from "./schemas.ts";
import { etDayOf, etHhMm } from "./time.ts";

// The Practice hub's session setup (02o §a2): the draft the form edits, its conversion to a `ReplaySessionV1`, and
// live validation against the contract's own Zod schema (the D6 pattern: the contract is the source of truth).

export const MAX_ARMED = 5;
export const EARLIEST_DAY = "2016-01-04";
export const REGULAR_WINDOW = { from: "09:30", to: "16:00" } as const;
export const EXTENDED_WINDOW = { from: "04:00", to: "20:00" } as const;
export const INTERVALS: readonly ReplayInterval[] = ["1m", "5m", "15m"];

export type ArmedRef = { source: "alert_strategy" | "filter"; id: number };
export type SetupDraft = {
  symbol: string;
  /** "YYYY-MM-DD", or "" until a day is picked. */
  day: string;
  /** Picked from the notable list while dates are hidden: the date stays masked and the session is stored with `hideDate: "yes"`. */
  dayHidden: boolean;
  session: "regular" | "extended";
  from: string;
  to: string;
  interval: ReplayInterval;
  armed: ArmedRef[];
};

export const defaultDraft = (): SetupDraft => ({
  symbol: "",
  day: "",
  dayHidden: false,
  session: "regular",
  ...REGULAR_WINDOW,
  interval: "5m",
  armed: [],
});

/** Switching session resets the window to that session's default bounds. */
export function withSession(draft: SetupDraft, session: SetupDraft["session"]): SetupDraft {
  return { ...draft, session, ...(session === "regular" ? REGULAR_WINDOW : EXTENDED_WINDOW) };
}

/** A notable-day row fills symbol and day; while dates are hidden the day is masked and flagged. */
export function withNotableDay(draft: SetupDraft, day: Pick<ReplayDay, "symbol" | "day">, datesHidden: boolean): SetupDraft {
  return { ...draft, symbol: day.symbol, day: day.day, dayHidden: datesHidden };
}

/** A date she typed is shown, never masked. */
export const withTypedDay = (draft: SetupDraft, day: string): SetupDraft => ({ ...draft, day, dayHidden: false });

export function toggleArmed(armed: readonly ArmedRef[], ref: ArmedRef): ArmedRef[] {
  const has = armed.some((item) => item.source === ref.source && item.id === ref.id);
  if (has) return armed.filter((item) => !(item.source === ref.source && item.id === ref.id));
  return armed.length >= MAX_ARMED ? [...armed] : [...armed, ref];
}

/** A practice session carries no risk plan of its own: the plan is the thread's (D-007, D-008), and the contract still
 *  wants a block, so a session is stored with the neutral one (no rule she did not choose) and the default lot size. */
const SESSION_SHARES = 100;
const NEUTRAL_PLAN = { stopRequired: "no", signalOnly: "no" } as const;

/** The draft as the contract's JSON. Nothing is null or boolean. */
export function draftToSpec(draft: SetupDraft): unknown {
  return {
    schemaVersion: 1,
    symbol: draft.symbol.trim().toUpperCase(),
    day: draft.day,
    window: { from: draft.from, to: draft.to },
    session: draft.session,
    interval: draft.interval,
    shares: SESSION_SHARES,
    armed: draft.armed.map(({ source, id }) => ({ source, id })),
    plan: NEUTRAL_PLAN,
    hideDate: draft.dayHidden ? "yes" : "no",
  };
}

export type SetupField = "symbol" | "day" | "window" | "interval" | "armed" | "form";
export type FieldProblems = Partial<Record<SetupField, string>>;

const FIELD_MESSAGE: Record<SetupField, string> = {
  symbol: "Enter a stock or ETF symbol, like NVDA",
  day: "Pick a day",
  window: "Pick a window that starts before it ends",
  interval: "Pick 1m, 5m or 15m",
  armed: "Arm up to 5 strategies",
  form: "Check the setup and try again",
};

/** Maps a contract or server path (`window.from`, `armed.0.id`) to the form field that shows it. */
export function fieldOfPath(path: string): SetupField {
  const first = path.split(".")[0];
  switch (first) {
    case "symbol": case "day": case "window": case "interval": case "armed": return first;
    case "session": return "window";
    case "hideDate": return "day";
    default: return "form";
  }
}

/** Server `422` problems to per-field messages. The server's day messages are plain English and shown as they are. */
export function fieldProblems(problems: readonly DeskApiProblem[]): FieldProblems {
  const result: FieldProblems = {};
  for (const problem of problems) {
    const field = fieldOfPath(problem.path);
    result[field] ??= problem.message || FIELD_MESSAGE[field];
  }
  return result;
}

// ---- the day ------------------------------------------------------------------------------------------------

const isWeekend = (day: string) => {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
};

const previousWeekday = (day: string): string => {
  const date = new Date(`${day}T12:00:00Z`);
  do date.setUTCDate(date.getUTCDate() - 1); while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
};

/** The latest day a replay can open: today after the regular close plus the 15 minute data delay (4:15 PM ET), else the previous weekday. */
export function latestReplayDay(now: Date): string {
  const iso = now.toISOString();
  const today = etDayOf(iso);
  return !isWeekend(today) && etHhMm(iso) >= "16:15" ? today : previousWeekday(today);
}

/** A quick local read of a typed day. Holidays and missing data are the server's call (its `422` shows inline). */
export function dayProblem(day: string, now: Date): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) return FIELD_MESSAGE.day;
  if (day < EARLIEST_DAY) return PRACTICE_COPY.beforeFloor;
  if (isWeekend(day)) return practiceText("noTrading", { day: formatEtDay(day) });
  if (day > latestReplayDay(now)) return PRACTICE_COPY.notFinished;
  return null;
}

// ---- validation -----------------------------------------------------------------------------------------------

export type ValidationResult = { ok: true; spec: ReturnType<typeof ReplaySessionV1Schema.parse> } | { ok: false; problems: FieldProblems };

/** Live validation: the contract's Zod schema plus the local day read. The first message per field wins. */
export function validateDraft(draft: SetupDraft, now: Date): ValidationResult {
  const problems: FieldProblems = {};
  if (draft.day === "") problems.day = FIELD_MESSAGE.day;
  else {
    const local = dayProblem(draft.day, now);
    if (local) problems.day = local;
  }
  const parsed = ReplaySessionV1Schema.safeParse(draftToSpec(draft));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldOfPath(issue.path.join("."));
      // A custom message (the window rules) is already plain; the generic Zod ones are replaced.
      problems[field] ??= issue.code === "custom" ? issue.message : FIELD_MESSAGE[field];
    }
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return parsed.success ? { ok: true, spec: parsed.data } : { ok: false, problems: { form: FIELD_MESSAGE.form } };
}

// ---- errors -------------------------------------------------------------------------------------------------

/** The plain message of a failed Practice request: the server's first problem or detail, else the fallback. */
export function problemMessage(error: unknown, fallback: string): string {
  if (error instanceof DeskApiError) {
    return error.problems[0]?.message || error.detail || fallback;
  }
  return fallback;
}
