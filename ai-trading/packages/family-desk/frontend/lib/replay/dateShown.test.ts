import assert from "node:assert/strict";
import test from "node:test";
import { dayDateShown, showDayDate } from "./dateShown.ts";

// D-174: Show date on a hidden day's chart band is the one state the Summary's clock, its "Next session starts" line and its End day question read.
test("Show date reveals that day only, and a day with no list reveals nothing", () => {
  assert.equal(dayDateShown(901), false);
  showDayDate(901);
  assert.equal(dayDateShown(901), true);
  assert.equal(dayDateShown(902), false, "the next day of the thread is hidden again");
  assert.equal(dayDateShown(null), false);
});
