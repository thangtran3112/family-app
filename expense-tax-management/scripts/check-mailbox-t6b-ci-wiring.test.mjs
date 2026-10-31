import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readPackage = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Phase 3D-B Task 6 -- traces the chain from the CI workflow (read-only --
 * never edited here) down to Phase 3D-B Task 6's real-PostgreSQL
 * discovery/review verification suite, the same way
 * check-mailbox-t6-ci-wiring.test.mjs traces Phase 3D-A Task 6's
 * PHASE_3D_A_T6_INTEGRATION wiring -- so a future refactor of either end
 * can't silently stop running it.
 */
test("verify-phase-0n runs Phase 3D-B Task 6's mailbox discovery/review verification suite with PHASE_3D_B_T6_INTEGRATION=1", () => {
  const verifyPhase0n = readPackage("scripts/verify-phase-0n.mjs");
  assert.match(
    verifyPhase0n,
    /test\/integration\/app-domain-3d-b-mailbox\.test\.ts/,
    "verify-phase-0n.mjs must invoke Task 6's mailbox verification suite directly",
  );
  assert.match(
    verifyPhase0n,
    /PHASE_3D_B_T6_INTEGRATION\s*:\s*"1"/,
    "verify-phase-0n.mjs must set PHASE_3D_B_T6_INTEGRATION=1 for that invocation",
  );
});
