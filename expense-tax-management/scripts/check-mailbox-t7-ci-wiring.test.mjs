import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readPackage = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Phase 3D-C Task 7 -- traces the chain from the CI workflow (read-only --
 * never edited here) down to Phase 3D-C Task 7's real-PostgreSQL mailbox
 * ingestion phase-verification suite, the same way
 * check-mailbox-t6-ci-wiring.test.mjs/check-mailbox-t6b-ci-wiring.test.mjs
 * trace Phase 3D-A/3D-B Task 6's own wiring -- so a future refactor of
 * either end can't silently stop running it.
 */
test("verify-phase-0n runs Phase 3D-C Task 7's mailbox ingestion phase-verification suite with PHASE_3D_C_T7_INTEGRATION=1", () => {
  const verifyPhase0n = readPackage("scripts/verify-phase-0n.mjs");
  assert.match(
    verifyPhase0n,
    /test\/integration\/app-domain-3d-c-mailbox\.test\.ts/,
    "verify-phase-0n.mjs must invoke Task 7's mailbox ingestion phase-verification suite directly",
  );
  assert.match(
    verifyPhase0n,
    /PHASE_3D_C_T7_INTEGRATION\s*:\s*"1"/,
    "verify-phase-0n.mjs must set PHASE_3D_C_T7_INTEGRATION=1 for that invocation",
  );
});
