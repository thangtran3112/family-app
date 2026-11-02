import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { dayStatusLine, journalStatusLine, replayStatusLine } from "./statusLine.ts";

const LISTED = { list_at: "2026-03-10T12:30:00Z", rescan: null, clock: null };
const scan = (asOf: string) => ({ seq: 1, as_of: asOf, data_through: "2026-03-10T13:17:00Z", new_count: 0, created_at: asOf });

test("D-043: the day list says where prices come from, that lists are built before the open, and when this one was built", () => {
  const line = dayStatusLine(LISTED);
  assert.deepEqual(line.left, ["Prices: Alpaca SIP · past days", "Day lists built before the open"]);
  assert.deepEqual(line.right, ["List built 8:30 AM ET", "Would-fire signals only · nothing is delivered"]);
  assert.deepEqual(dayStatusLine({ ...LISTED, clock: "2026-03-10T13:29:00Z" }).left, line.left, "9:29 AM ET: still before the open");
});

test("D-165: once the day clock is at the open, the status line no longer says lists are built before it", () => {
  const line = dayStatusLine({ ...LISTED, clock: "2026-03-10T13:30:00Z" });
  assert.deepEqual(line.left, ["Prices: Alpaca SIP · past days"]);
  assert.equal(line.right[0], "List built 8:30 AM ET", "no re-scan yet: the list time is the build time");
});

test("D-165: after a re-scan the status line gives the scan's clock as the one list time", () => {
  const line = dayStatusLine({ ...LISTED, clock: "2026-03-10T13:32:00Z", rescan: scan("2026-03-10T13:32:00Z") });
  assert.deepEqual(line.right, ["List built 9:32 AM ET", "Would-fire signals only · nothing is delivered"]);
});

test("D-043: the thread journal says it updates when a day ends and which day the balance stands at", () => {
  assert.deepEqual(journalStatusLine([{ n: 1 }, { n: 2 }, { n: 8 }]), {
    left: ["Prices: Alpaca SIP · past days", "Journal updates when a day ends"],
    right: ["Balance as of day 8", "Would-fire signals only · nothing is delivered"],
  });
  assert.equal(journalStatusLine([]).right[0], "Balance at the start · no day ended yet");
});

test("the replay line names the session's own feed and the replay clock", () => {
  const sip = replayStatusLine("sip", "2026-10-23T14:07:00Z");
  assert.deepEqual(sip.left, ["Prices: Alpaca SIP · replay", "Consolidated tape · all US exchanges"]);
  assert.equal(sip.right[0], "Replay clock 10:07:00 AM ET");
  assert.equal(replayStatusLine("iex", "2026-10-23T14:07:00Z").left[0], "Prices: Alpaca IEX · replay", "an IEX session never claims SIP");
  assert.equal(replayStatusLine("off", "2026-10-23T14:07:00Z").left[1], "Tape off · swing prices are one-minute closes", "a swing session with the tape off says its prices are closes");
});

test("no status line carries a banned term", () => {
  const lines = [dayStatusLine(LISTED), journalStatusLine([{ n: 3 }]), replayStatusLine("sip", "2026-10-23T14:07:00Z"), replayStatusLine("iex", "2026-10-23T14:07:00Z")];
  for (const line of lines) for (const text of [...line.left, ...line.right]) assert.equal(containsPracticeBannedTerm(text), false, text);
});
