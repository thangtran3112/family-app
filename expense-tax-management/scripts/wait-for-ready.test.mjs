import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { waitForReady } from "./wait-for-ready.mjs";

// Regression: verify-phase-0p probed App readiness once, right after
// `compose up -d app-api` returned. The probe then raced the container start.
const countingPause = () => {
  let pauses = 0;
  return { pause: () => { pauses += 1; }, count: () => pauses };
};

test("returns on the first passing probe without pausing", () => {
  let probes = 0;
  const pause = countingPause();
  assert.equal(waitForReady(() => { probes += 1; return true; }, { pause: pause.pause }), true);
  assert.equal(probes, 1);
  assert.equal(pause.count(), 0);
});

test("retries a probe that fails while the app is still starting", () => {
  const outcomes = [false, false, false, true];
  const pause = countingPause();
  assert.equal(waitForReady(() => outcomes.shift(), { pause: pause.pause }), true);
  assert.equal(outcomes.length, 0);
  assert.equal(pause.count(), 3);
});

test("gives up after the attempt budget and never probes past it", () => {
  let probes = 0;
  const pause = countingPause();
  const ready = waitForReady(() => { probes += 1; return false; }, { attempts: 5, pause: pause.pause });
  assert.equal(ready, false);
  assert.equal(probes, 5);
  assert.equal(pause.count(), 4);
});

test("verify-phase-0p gates App readiness through the retry helper", () => {
  const script = readFileSync(
    fileURLToPath(new URL("verify-phase-0p.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(script, /import \{ waitForReady \} from "\.\/wait-for-ready\.mjs";/);
  assert.match(script, /waitForReady\([\s\S]*?\/health\/ready/);
});
