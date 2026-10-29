import assert from "node:assert/strict";
import test from "node:test";
import {
  COVERED_CALL_DEFAULTS, coveredCallProblems, DEFAULT_COLUMNS, MAX_COLUMNS, METRIC_KEYS, readCoveredCallSettings, readFundamentalColumns,
  withCoveredCallSettings, withFundamentalColumns,
} from "./fundamental.ts";

test("columns fall back to the defaults unless the saved list is one the backend accepts", () => {
  assert.deepEqual(readFundamentalColumns({}), [...DEFAULT_COLUMNS]);
  assert.deepEqual(readFundamentalColumns({ fundamental_columns: ["fwd_pe", "ai_rating"] }), ["fwd_pe", "ai_rating"]);
  assert.deepEqual(readFundamentalColumns({ fundamental_columns: [] }), []);
  for (const bad of [["nope"], ["fwd_pe", "fwd_pe"], METRIC_KEYS.slice(0, MAX_COLUMNS + 1), "fwd_pe", [1]]) {
    assert.deepEqual(readFundamentalColumns({ fundamental_columns: bad }), [...DEFAULT_COLUMNS]);
  }
  assert.deepEqual(withFundamentalColumns({ pause_all: true }, ["fwd_pe"]), { pause_all: true, fundamental_columns: ["fwd_pe"] });
});

test("covered-call settings start from the engine defaults and merge what is saved", () => {
  assert.deepEqual(readCoveredCallSettings({}), COVERED_CALL_DEFAULTS);
  assert.deepEqual(readCoveredCallSettings({ covered_calls: { min_dte: 30, cap_pct: "x" } }), { ...COVERED_CALL_DEFAULTS, min_dte: 30 });
  assert.deepEqual(withCoveredCallSettings({ a: 1 }, COVERED_CALL_DEFAULTS), { a: 1, covered_calls: COVERED_CALL_DEFAULTS });
});

test("the scan filters name each problem before a save, with the backend's bounds", () => {
  const ok = { ...COVERED_CALL_DEFAULTS };
  assert.deepEqual(coveredCallProblems(ok), {});
  assert.deepEqual(coveredCallProblems({ ...ok, min_dte: 50 }), { max_dte: "Must not be below 50" });
  assert.deepEqual(coveredCallProblems({ ...ok, min_delta: 0.5 }), { max_delta: "Must not be below 0.5" });
  assert.equal(coveredCallProblems({ ...ok, cap_pct: 0 }).cap_pct, "Must be between 1 and 100");
  assert.equal(coveredCallProblems({ ...ok, cap_pct: 101 }).cap_pct, "Must be between 1 and 100");
  assert.equal(coveredCallProblems({ ...ok, min_dte: 21.5 }).min_dte, "Enter a whole number");
  assert.equal(coveredCallProblems({ ...ok, min_bid: null }).min_bid, "Enter a number");
  assert.equal(coveredCallProblems({ ...ok, max_delta: 1 }).max_delta, "Must be between 0.01 and 0.99");
});
