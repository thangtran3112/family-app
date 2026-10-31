import {
  DEFAULT_STARTING_BALANCE,
  PracticeThreadCreateV1Schema,
  PracticeThreadPatchV1Schema,
} from "@ai-trading/contracts/practice-thread-v1";
import type { DeskApiProblem } from "../api/client.ts";
import { formatWhole } from "./threadView.ts";
import type { ThreadPlan } from "./threads.ts";

// The hub's "New thread" form and the journal's "Edit plan" form (02r): the draft the form edits, its conversion to a
// `PracticeThreadCreateV1` or `PracticeThreadPatchV1`, and live validation against the contract's own Zod schema (the D6
// pattern). The risk plan lives on the thread (D-007); the daily-list form no longer asks for it.

export const MIN_STARTING_BALANCE = 1000;
export const MAX_STARTING_BALANCE = 10_000_000;

export type ThreadDraft = {
  /** Whole dollars as typed; the contract's default is 50,000. */
  startingBalance: string;
  mode: "day" | "swing";
  stopNoteOnEntry: boolean;
  tradeOnlyOnSignal: boolean;
  maxLossUsd: string;
  maxTrades: string;
  planNote: string;
};

export const defaultThreadDraft = (): ThreadDraft => ({
  startingBalance: String(DEFAULT_STARTING_BALANCE),
  mode: "day",
  stopNoteOnEntry: true,
  tradeOnlyOnSignal: false,
  maxLossUsd: "",
  maxTrades: "",
  planNote: "",
});

/** The starting balance as shown once she leaves the box: "50000" reads "50,000". Anything that is not a whole number stays as typed, so its error can name it. */
export function formatBalanceInput(text: string): string {
  const bare = text.trim().replaceAll(",", "");
  return /^\d+$/.test(bare) ? Number(bare).toLocaleString("en-US") : text;
}

const numberOrNaN = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text.replaceAll(",", "")));

/** The plan half of the draft as the contract's JSON. Optional fields are left out when empty; nothing is null or boolean. */
export function threadPlanToSpec(draft: Pick<ThreadDraft, "stopNoteOnEntry" | "tradeOnlyOnSignal" | "maxLossUsd" | "maxTrades" | "planNote">) {
  const plan: Record<string, unknown> = {
    stopNoteOnEntry: draft.stopNoteOnEntry ? "yes" : "no",
    tradeOnlyOnSignal: draft.tradeOnlyOnSignal ? "yes" : "no",
  };
  if (draft.maxLossUsd.trim() !== "") plan.maxLossUsd = numberOrNaN(draft.maxLossUsd);
  if (draft.maxTrades.trim() !== "") plan.maxTrades = numberOrNaN(draft.maxTrades);
  if (draft.planNote.trim() !== "") plan.planNote = draft.planNote.trim();
  return plan;
}

export const threadDraftToSpec = (draft: ThreadDraft): unknown => ({
  schemaVersion: 1,
  mode: draft.mode,
  startingBalance: numberOrNaN(draft.startingBalance),
  plan: threadPlanToSpec(draft),
});

/** A thread's plan as a draft, for the "Edit plan" form. */
export const planToDraft = (plan: ThreadPlan, startingBalance: number): ThreadDraft => ({
  startingBalance: String(startingBalance),
  mode: "day",
  stopNoteOnEntry: plan.stopNoteOnEntry === "yes",
  tradeOnlyOnSignal: plan.tradeOnlyOnSignal === "yes",
  maxLossUsd: plan.maxLossUsd === undefined ? "" : String(plan.maxLossUsd),
  maxTrades: plan.maxTrades === undefined ? "" : String(plan.maxTrades),
  planNote: plan.planNote ?? "",
});

export const threadPatchToSpec = (draft: ThreadDraft): unknown => ({ schemaVersion: 1, plan: threadPlanToSpec(draft) });

export type ThreadField = "startingBalance" | "mode" | "stopNoteOnEntry" | "tradeOnlyOnSignal" | "maxLossUsd" | "maxTrades" | "planNote" | "form";
export type ThreadProblems = Partial<Record<ThreadField, string>>;

const FIELD_MESSAGE: Record<ThreadField, string> = {
  startingBalance: `Starting balance: whole dollars from ${MIN_STARTING_BALANCE.toLocaleString("en-US")} to ${MAX_STARTING_BALANCE.toLocaleString("en-US")}`,
  mode: "Pick day trading",
  stopNoteOnEntry: "Pick yes or no",
  tradeOnlyOnSignal: "Pick yes or no",
  maxLossUsd: "Max loss: whole dollars from 1 to 100,000",
  maxTrades: "Max trades: a whole number from 1 to 50",
  planNote: "Plan note: up to 500 plain characters",
  form: "Check the thread and try again",
};

/** Maps a contract or server path (`plan.maxLossUsd`, `startingBalance`) to the form field that shows it. */
export function threadFieldOfPath(path: string): ThreadField {
  const parts = path.split(".");
  const last = parts[parts.length - 1] ?? "";
  switch (last) {
    case "startingBalance": case "mode": case "stopNoteOnEntry": case "tradeOnlyOnSignal": case "maxLossUsd": case "maxTrades": case "planNote":
      return last;
    default:
      return "form";
  }
}

/** Server `422` problems to per-field messages. The server's own sentences are plain English and shown as they are. */
export function threadProblems(problems: readonly DeskApiProblem[]): ThreadProblems {
  const result: ThreadProblems = {};
  for (const problem of problems) {
    const field = threadFieldOfPath(problem.path);
    result[field] ??= problem.message || FIELD_MESSAGE[field];
  }
  return result;
}

type Validation<T> = { ok: true; spec: T } | { ok: false; problems: ThreadProblems };

/** The server's rule on top of the contract: a day's max loss cannot be more than the whole starting balance. */
function maxLossProblem(maxLoss: number | undefined, balance: number): string | null {
  return maxLoss !== undefined && Number.isFinite(balance) && maxLoss > balance
    ? `Max loss can't be more than your simulated starting balance (${formatWhole(balance)})`
    : null;
}

function readIssues(issues: ReadonlyArray<{ path: PropertyKey[]; code: string; message: string }>): ThreadProblems {
  const problems: ThreadProblems = {};
  for (const issue of issues) {
    const field = threadFieldOfPath(issue.path.map(String).join("."));
    problems[field] ??= issue.code === "custom" ? issue.message : FIELD_MESSAGE[field];
  }
  return problems;
}

/** Live validation of the New thread form against `PracticeThreadCreateV1`. */
export function validateThreadDraft(draft: ThreadDraft): Validation<ReturnType<typeof PracticeThreadCreateV1Schema.parse>> {
  const parsed = PracticeThreadCreateV1Schema.safeParse(threadDraftToSpec(draft));
  if (!parsed.success) return { ok: false, problems: readIssues(parsed.error.issues) };
  const over = maxLossProblem(parsed.data.plan.maxLossUsd, parsed.data.startingBalance);
  return over ? { ok: false, problems: { maxLossUsd: over } } : { ok: true, spec: parsed.data };
}

/** Live validation of the Edit plan form against `PracticeThreadPatchV1`; `startingBalance` is the thread's own. */
export function validatePlanEdit(draft: ThreadDraft, startingBalance: number): Validation<ReturnType<typeof PracticeThreadPatchV1Schema.parse>> {
  const parsed = PracticeThreadPatchV1Schema.safeParse(threadPatchToSpec(draft));
  if (!parsed.success) return { ok: false, problems: readIssues(parsed.error.issues) };
  const over = maxLossProblem(parsed.data.plan.maxLossUsd, startingBalance);
  return over ? { ok: false, problems: { maxLossUsd: over } } : { ok: true, spec: parsed.data };
}
