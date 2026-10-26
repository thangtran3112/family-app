import assert from "node:assert/strict";
import test from "node:test";
import { applyAdvance, viewFromFeed, type ReplayView } from "./feedState.ts";
import { feed } from "./fixtures.ts";
import { createRequestQueue } from "./requestQueue.ts";
import { ReplayDeltaSchema, ReplayFeedSchema, type ReplayDelta } from "./schemas.ts";
import { swingDelta, swingDeltaQuiet } from "./swingFixtures.ts";

// The workspace's Step, Jump and Next-signal presses queue behind the request in flight (02o §d). When that request
// stopped at a crossed stop (02p §k) a queued press must drop itself: it would move the playhead past the crossing and
// clear the toast the server will not show again.

/** The hook's glue in miniature: an advance applies its answer to the view and tells the queue when it paused. */
function player(answers: ReplayDelta[]) {
  const queue = createRequestQueue();
  const requests: string[] = [];
  let view: ReplayView = viewFromFeed(ReplayFeedSchema.parse({ ...feed, bars: [], signals: [] }), "5m");
  const advance = async (target: string) => {
    requests.push(target);
    await new Promise((done) => setTimeout(done, 1));
    const answer = answers.shift()!;
    view = applyAdvance(view, answer);
    if (answer.paused != null) queue.notePause();
  };
  return {
    queue,
    requests,
    advance,
    step: () => queue.run(() => advance("step"), { dropAfterPause: true }),
    view: () => view,
  };
}

const later = (iso: string) => ReplayDeltaSchema.parse({ ...swingDeltaQuiet, revealed_through: iso });

test("two quick steps where the first pauses: one request, and the pause is still there", async () => {
  const p = player([swingDelta, later("2026-07-14T16:00:00Z")]);
  await Promise.all([p.step(), p.step()]);
  assert.deepEqual(p.requests, ["step"]);
  assert.equal(p.view().paused?.symbol, "AMD");
  assert.equal(p.view().revealedThrough, "2026-07-14T15:42:00Z", "the playhead stays on the crossing");
});

test("without a pause the queued press runs, in order", async () => {
  const p = player([later("2026-07-14T15:00:00Z"), later("2026-07-14T15:05:00Z")]);
  await Promise.all([p.step(), p.step()]);
  assert.deepEqual(p.requests, ["step", "step"]);
  assert.equal(p.view().revealedThrough, "2026-07-14T15:05:00Z");
});

test("a press made after the pause answered is a new decision and runs", async () => {
  const p = player([swingDelta, later("2026-07-14T15:43:00Z")]);
  await p.step();
  await p.step();
  assert.equal(p.requests.length, 2);
  assert.equal(p.view().paused, null, "she stepped on: the next advance clears the pause");
});

test("a task that is not a press (a mark, a re-read) still runs after a pause, and a failing task does not stop the queue", async () => {
  const queue = createRequestQueue();
  const order: string[] = [];
  queue.notePause();
  const failed = queue.run(async () => {
    throw new Error("surprise");
  });
  const after = queue.run(async () => {
    order.push("after");
    return 7;
  });
  assert.equal(await failed, null);
  assert.equal(await after, 7);
  assert.deepEqual(order, ["after"]);
});
