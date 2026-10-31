import assert from "node:assert/strict";
import test from "node:test";
import { DeskApiError } from "../api/client.ts";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { activeThread } from "./threadFixtures.ts";
import {
  defaultThreadDraft,
  formatBalanceInput,
  planToDraft,
  threadDraftToSpec,
  threadFieldOfPath,
  threadPatchToSpec,
  threadProblems,
  validatePlanEdit,
  validateThreadDraft,
} from "./threadSetup.ts";

test("the New thread form starts at 50,000 with a stop on every entry, day trading, and no optional limit", () => {
  const draft = defaultThreadDraft();
  assert.equal(draft.startingBalance, "50000");
  assert.equal(draft.mode, "day");
  assert.deepEqual(threadDraftToSpec(draft), {
    schemaVersion: 1,
    mode: "day",
    startingBalance: 50000,
    plan: { stopNoteOnEntry: "yes", tradeOnlyOnSignal: "no" },
  });
  const result = validateThreadDraft(draft);
  assert.equal(result.ok, true);
});

test("optional limits and the note go in only when typed; commas in the balance are read", () => {
  const spec = threadDraftToSpec({ ...defaultThreadDraft(), startingBalance: "25,000", maxLossUsd: "600", maxTrades: "3", planNote: "  VWAP only  " });
  assert.deepEqual(spec, {
    schemaVersion: 1,
    mode: "day",
    startingBalance: 25000,
    plan: { stopNoteOnEntry: "yes", tradeOnlyOnSignal: "no", maxLossUsd: 600, maxTrades: 3, planNote: "VWAP only" },
  });
});

test("each field has its own plain message", () => {
  const bad = validateThreadDraft({ ...defaultThreadDraft(), startingBalance: "500", maxTrades: "99", planNote: "x".repeat(501) });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.problems.startingBalance, "Starting balance: whole dollars from 1,000 to 10,000,000");
    assert.equal(bad.problems.maxTrades, "Max trades: a whole number from 1 to 50");
    assert.equal(bad.problems.planNote, "Plan note: up to 500 plain characters");
  }
  const blank = validateThreadDraft({ ...defaultThreadDraft(), startingBalance: "" });
  assert.equal(blank.ok, false);
  const swing = validateThreadDraft({ ...defaultThreadDraft(), mode: "swing" });
  assert.equal(swing.ok, false, "a swing create needs its swing block (02p); the draft has none yet");
  if (!swing.ok) assert.equal(swing.problems.form, "swing is present exactly when mode is swing");
});

test("a max loss above the starting balance is refused in the server's words", () => {
  const over = validateThreadDraft({ ...defaultThreadDraft(), startingBalance: "1000", maxLossUsd: "2000" });
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.problems.maxLossUsd, "Max loss can't be more than your simulated starting balance ($1,000)");
  assert.equal(validatePlanEdit({ ...defaultThreadDraft(), maxLossUsd: "60000" }, 50000).ok, false);
  assert.equal(validatePlanEdit({ ...defaultThreadDraft(), maxLossUsd: "600" }, 50000).ok, true);
});

test("a thread's plan round-trips through the edit draft into a patch", () => {
  const draft = planToDraft(activeThread.thread.plan, activeThread.thread.startingBalance);
  assert.equal(draft.maxLossUsd, "600");
  assert.deepEqual(threadPatchToSpec(draft), { schemaVersion: 1, plan: activeThread.thread.plan });
  assert.equal(validatePlanEdit(draft, 50000).ok, true);
  assert.equal(planToDraft({ stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" }, 50000).planNote, "");
});

test("server problems map to the form's fields, and a 409 stays a plain sentence", () => {
  assert.equal(threadFieldOfPath("plan.maxLossUsd"), "maxLossUsd");
  assert.equal(threadFieldOfPath("startingBalance"), "startingBalance");
  assert.equal(threadFieldOfPath("plan"), "form");
  assert.equal(threadFieldOfPath("mode"), "mode");
  const problems = threadProblems([
    { path: "mode", message: "Swing threads are not open yet · start a day thread" },
    { path: "plan.maxLossUsd", message: "" },
  ]);
  assert.equal(problems.mode, "Swing threads are not open yet · start a day thread");
  assert.equal(problems.maxLossUsd, "Max loss: whole dollars from 1 to 100,000");
  const error = new DeskApiError("http", 409, { detail: "A day thread is already active" });
  assert.equal(error.detail, "A day thread is already active");
});

test("the form's own sentences pass the banned-term check", () => {
  const sentences = ["Max loss can't be more than your simulated starting balance ($1,000)", "Starting balance: whole dollars from 1,000 to 10,000,000"];
  for (const text of sentences) assert.equal(containsPracticeBannedTerm(text), false, text);
});

// M-07: the starting balance reads "50,000" once she leaves the box; what is not a whole number is left for the error to name.
test("the balance box groups thousands on blur and leaves anything else as typed", () => {
  assert.equal(formatBalanceInput("50000"), "50,000");
  assert.equal(formatBalanceInput("1234567"), "1,234,567");
  assert.equal(formatBalanceInput("50,000"), "50,000");
  assert.equal(formatBalanceInput(" 2500 "), "2,500");
  assert.equal(formatBalanceInput(""), "");
  assert.equal(formatBalanceInput("12.5"), "12.5");
  assert.equal(formatBalanceInput("abc"), "abc");
  assert.equal(validateThreadDraft({ ...defaultThreadDraft(), startingBalance: "50,000" }).ok, true);
});
