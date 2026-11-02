import assert from "node:assert/strict";
import test from "node:test";
import { notUpdating, STALE_AFTER_MS } from "./stale.ts";

test("a followed chart is updating until two polls in a row failed or ten seconds passed without an answer", () => {
  assert.equal(notUpdating(0, 0), false);
  assert.equal(notUpdating(1, 4000), false, "one failed poll is a blip: the next one tries again");
  assert.equal(notUpdating(2, 4000), true, "two in a row");
  assert.equal(notUpdating(0, STALE_AFTER_MS), false, "ten seconds exactly is still fresh");
  assert.equal(notUpdating(0, STALE_AFTER_MS + 1), true, "an answer older than ten seconds, with no poll failing (a poll waiting out its back-off)");
});
