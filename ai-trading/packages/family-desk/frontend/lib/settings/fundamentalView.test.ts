import assert from "node:assert/strict";
import test from "node:test";
import { containsBannedTerm } from "../desk/freshness.ts";
import { COVERED_CALL_DEFAULTS } from "./fundamental.ts";
import {
  ACCOUNT_LABEL_MAX, accountProblemText, ACCOUNT_SAVE_ERROR, ACCOUNT_TYPE_OPTIONS, ALERT_TEMPLATES, IMPORT_REREAD_DELAYS_MS, IMPORT_SOURCE_TEXT,
  lastImportText, SCAN_FIELDS, scanDefaultsDraft, scanDraftChanged, scanDraftFromSettings, scanProblemsOfDraft, scanSettingsOfDraft,
  serverProblemsToFields, validateAccountLabel,
} from "./fundamentalView.ts";

test("account names are trimmed, not empty and at most 40 characters", () => {
  assert.deepEqual(validateAccountLabel("  IRA  "), { ok: true, label: "IRA" });
  assert.deepEqual(validateAccountLabel("   "), { ok: false, message: "Enter a name" });
  assert.equal(validateAccountLabel("x".repeat(ACCOUNT_LABEL_MAX)).ok, true);
  assert.deepEqual(validateAccountLabel("x".repeat(ACCOUNT_LABEL_MAX + 1)), { ok: false, message: "Use 40 characters or fewer" });
  assert.equal(accountProblemText([{ path: "label", message: "is too long" }]), "is too long");
  assert.equal(accountProblemText([]), ACCOUNT_SAVE_ERROR);
  assert.deepEqual(ACCOUNT_TYPE_OPTIONS.map((option) => option.value), ["taxable", "ira", "roth"]);
});

test("the last import line names the statement day and when it arrived", () => {
  assert.equal(lastImportText({ statement_date: "2026-10-23", imported_at: "2026-10-24T09:15:00Z" }), "Statement Fri 2026-10-23 · imported Sat 2026-10-24 5:15 AM ET");
  assert.equal(lastImportText({ statement_date: "2026-10-23", imported_at: null }), "Statement Fri 2026-10-23");
  assert.equal(lastImportText({ statement_date: null, imported_at: null }), "No import yet");
  assert.equal(IMPORT_SOURCE_TEXT, "IBKR Flex");
  assert.ok(IMPORT_REREAD_DELAYS_MS.length > 0 && IMPORT_REREAD_DELAYS_MS.every((ms) => ms > 0));
});

test("scan drafts start from the saved values and name each problem before a save", () => {
  assert.deepEqual(scanDraftFromSettings({}), scanDefaultsDraft());
  assert.equal(scanDefaultsDraft().min_dte, "21");
  assert.equal(scanDraftFromSettings({ covered_calls: { cap_pct: 40 } }).cap_pct, "40");

  const saved = scanDefaultsDraft();
  assert.deepEqual(scanProblemsOfDraft(saved), {});
  assert.equal(scanDraftChanged(saved, saved), false);
  assert.equal(scanDraftChanged({ ...saved, min_bid: "0.25" }, saved), true);

  assert.deepEqual(scanProblemsOfDraft({ ...saved, min_dte: "50" }), { max_dte: "Must not be below 50" });
  assert.equal(scanProblemsOfDraft({ ...saved, cap_pct: "" }).cap_pct, "Enter a number");
  assert.equal(scanProblemsOfDraft({ ...saved, cap_pct: "abc" }).cap_pct, "Enter a number");
  assert.equal(scanProblemsOfDraft({ ...saved, cap_pct: "0" }).cap_pct, "Must be between 1 and 100");
  assert.equal(scanProblemsOfDraft({ ...saved, min_open_interest: "1.5" }).min_open_interest, "Enter a whole number");

  assert.deepEqual(scanSettingsOfDraft({ ...saved, max_dte: " 60 " }), { ...COVERED_CALL_DEFAULTS, max_dte: 60 });
  assert.deepEqual(SCAN_FIELDS.map((field) => field.key), Object.keys(COVERED_CALL_DEFAULTS));
});

test("a server 422 names its field; other paths are ignored", () => {
  assert.deepEqual(
    serverProblemsToFields([
      { path: "covered_calls.max_dte", message: "must not be below 50" },
      { path: "covered_calls.cap_pct", message: "must be between 1 and 100" },
      { path: "mask_values", message: "must be true or false" },
      { path: "covered_calls.nope", message: "x" },
    ]),
    { max_dte: "must not be below 50", cap_pct: "must be between 1 and 100" },
  );
});

test("every word on these cards is free of banned wording", () => {
  const words = [
    ...SCAN_FIELDS.map((field) => field.label),
    ...ALERT_TEMPLATES.flatMap((template) => [template.title, template.note]),
    ACCOUNT_SAVE_ERROR, lastImportText({ statement_date: "2026-10-23", imported_at: "2026-10-24T09:15:00Z" }),
  ];
  for (const text of words) assert.equal(containsBannedTerm(text), false, text);
  assert.deepEqual(ALERT_TEMPLATES.map((template) => template.id), ["covered_call_income", "short_call_risk", "ai_daily_view"]);
});
