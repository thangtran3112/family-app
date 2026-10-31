import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readPackage = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Phase 3D-B Task 2 fix round 1 (review finding 3) -- traces the chain
 * from the CI workflow down to Task 2's real-PostgreSQL lease/fence
 * suite, the same way check-mailbox-t6-ci-wiring.test.mjs traces Task 6's
 * PHASE_3D_A_T6_INTEGRATION wiring. Before this fix, the suite only ran
 * locally with the flag set by hand -- no required command exercised it.
 */
test("verify-phase-0n runs Phase 3D-B Task 2's mailbox lease/fence suite with PHASE_3D_B_T2_INTEGRATION=1", () => {
  const verifyPhase0n = readPackage("scripts/verify-phase-0n.mjs");
  assert.match(
    verifyPhase0n,
    /test\/mailbox-scans\.test\.ts/,
    "verify-phase-0n.mjs must invoke Task 2's mailbox-scans.test.ts directly",
  );
  assert.match(
    verifyPhase0n,
    /PHASE_3D_B_T2_INTEGRATION\s*:\s*"1"/,
    "verify-phase-0n.mjs must set PHASE_3D_B_T2_INTEGRATION=1 for that invocation",
  );
});
