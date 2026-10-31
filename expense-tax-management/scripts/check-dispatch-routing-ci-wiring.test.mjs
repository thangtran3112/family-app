import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { runTask7WithIsolatedAppApi } from "./task7-dispatch-isolation.mjs";

const readPackage = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Traces the chain from the CI workflow (read-only -- never edited here) down
 * to the Task 7 Stage A real-PostgreSQL suite, so a future refactor of
 * either end can't silently stop running it. Review finding: the suite
 * exists but PHASE_T7A_INTEGRATION was never set anywhere CI reaches, so it
 * always skipped.
 */
test("verify-phase-0n runs the Task 7 Stage A dispatch routing fence suite with PHASE_T7A_INTEGRATION=1", () => {
  const verifyPhase0n = readPackage("scripts/verify-phase-0n.mjs");
  assert.match(
    verifyPhase0n,
    /test\/integration\/app-domain-task7-dispatch-routing\.test\.ts/,
    "verify-phase-0n.mjs must invoke the Task 7 Stage A suite directly",
  );
  assert.match(
    verifyPhase0n,
    /PHASE_T7A_INTEGRATION\s*:\s*"1"/,
    "verify-phase-0n.mjs must set PHASE_T7A_INTEGRATION=1 for that invocation",
  );
});

test("verify-phase-0n isolates Task 7 from a chain-started App API and restores it", () => {
  const verifyPhase0n = readPackage("scripts/verify-phase-0n.mjs");
  assert.match(verifyPhase0n, /runTask7WithIsolatedAppApi/);
  assert.match(verifyPhase0n, /ps[\s\S]*-q[\s\S]*app-api/);
  assert.match(verifyPhase0n, /stop[\s\S]*app-api/);
  assert.match(verifyPhase0n, /up[\s\S]*-d[\s\S]*app-api/);
  const preExistingGuard = verifyPhase0n.indexOf("if (appApiBeforeRegression)");
  const regressionStart = verifyPhase0n.indexOf('run("Regression through Office"');
  assert.ok(preExistingGuard >= 0, "verify-phase-0n must refuse a pre-existing App API");
  assert.ok(
    preExistingGuard < regressionStart,
    "pre-existing App API refusal must happen before the regression chain can touch it",
  );
});

test("Task 7 resets routing after every test, including assertion failures", () => {
  const task7 = readPackage("test/integration/app-domain-task7-dispatch-routing.test.ts");
  assert.match(task7, /afterEach\([\s\S]*resetRoutingToGenerationOne/);
});

test("stops and restores only an App API started by the verification chain", () => {
  const calls = [];
  runTask7WithIsolatedAppApi({
    appApiWasRunning: false,
    appApiIsRunning: true,
    stopAppApi: () => calls.push("stop"),
    runTask7: () => calls.push("test"),
    startAppApi: () => calls.push("start"),
  });
  assert.deepEqual(calls, ["stop", "test", "start"]);
});

test("restores a chain-started App API even when Task 7 fails", () => {
  const calls = [];
  assert.throws(() => runTask7WithIsolatedAppApi({
    appApiWasRunning: false,
    appApiIsRunning: true,
    stopAppApi: () => calls.push("stop"),
    runTask7: () => { calls.push("test"); throw new Error("failed"); },
    startAppApi: () => calls.push("start"),
  }), /failed/);
  assert.deepEqual(calls, ["stop", "test", "start"]);
});

test("refuses to stop an App API that predated the verification chain", () => {
  const calls = [];
  assert.throws(() => runTask7WithIsolatedAppApi({
    appApiWasRunning: true,
    appApiIsRunning: true,
    stopAppApi: () => calls.push("stop"),
    runTask7: () => calls.push("test"),
    startAppApi: () => calls.push("start"),
  }), /pre-existing App API/);
  assert.deepEqual(calls, []);
});

test("runs directly when no App API is active", () => {
  const calls = [];
  runTask7WithIsolatedAppApi({
    appApiWasRunning: false,
    appApiIsRunning: false,
    stopAppApi: () => calls.push("stop"),
    runTask7: () => calls.push("test"),
    startAppApi: () => calls.push("start"),
  });
  assert.deepEqual(calls, ["test"]);
});
