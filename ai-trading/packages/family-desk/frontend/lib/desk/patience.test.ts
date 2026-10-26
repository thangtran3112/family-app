import assert from "node:assert/strict";
import test from "node:test";
import { DeskApiError } from "../api/client.ts";
import { gatewayGaveUp, savePlanPatiently, whenReady } from "./patience.ts";

const instant = async () => {};
const gateway = () => new DeskApiError("http", 524);

test("a gateway timeout is repeated until the server answers, saying it is still working each time", async () => {
  let calls = 0;
  let waits = 0;
  const answer = await whenReady(
    async () => {
      calls += 1;
      if (calls < 3) throw gateway();
      return "ready";
    },
    { sleep: instant, onWaiting: () => (waits += 1) },
  );
  assert.deepEqual([answer, calls, waits], ["ready", 3, 2]);
});

test("a refusal or a server error is not repeated, and a gateway that never recovers gives up after the attempts", async () => {
  let calls = 0;
  await assert.rejects(whenReady(async () => { calls += 1; throw new DeskApiError("http", 500); }, { sleep: instant }));
  await assert.rejects(whenReady(async () => { calls += 1; throw new DeskApiError("http", 422); }, { sleep: instant }));
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(whenReady(async () => { calls += 1; throw gateway(); }, { sleep: instant, attempts: 4 }), (error: unknown) => gatewayGaveUp(error));
  assert.equal(calls, 4);
});

test("a dropped connection counts as a gateway giving up; an abort does not", () => {
  assert.equal(gatewayGaveUp(new TypeError("Failed to fetch")), true);
  assert.equal(gatewayGaveUp(new DOMException("aborted", "AbortError")), false);
  assert.equal(gatewayGaveUp(new DeskApiError("unauthenticated", 401)), false);
  for (const status of [502, 503, 504, 522, 524]) assert.equal(gatewayGaveUp(new DeskApiError("http", status)), true);
});

test("a plan save cut short by the gateway waits for the new plan and then continues it, never saving twice", async () => {
  let saves = 0;
  let polls = 0;
  const answer = await savePlanPatiently(
    async () => { saves += 1; throw gateway(); },
    async () => "opened",
    async () => { polls += 1; return polls < 3 ? 4 : 5; },
    4,
    { sleep: instant },
  );
  assert.deepEqual([answer, saves, polls], ["opened", 1, 3]);
});

test("a plan save that never shows up gives up with the original error", async () => {
  await assert.rejects(savePlanPatiently(async () => { throw gateway(); }, async () => "opened", async () => 4, 4, { sleep: instant, attempts: 2 }), (error: unknown) => gatewayGaveUp(error));
});
