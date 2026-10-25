import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { dayStatusLine, journalStatusLine, replayStatusLine } from "./statusLine.ts";

test("D-043: the day list says where prices come from, that lists are built before the open, and when this one was built", () => {
  const line = dayStatusLine({ list_at: "2026-03-10T12:30:00Z" });
  assert.deepEqual(line.left, ["Prices: Alpaca SIP · past days", "Day lists built before the open"]);
  assert.deepEqual(line.right, ["List built 8:30 AM ET", "Would-fire signals only · nothing is delivered"]);
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
});

test("no status line carries a banned term", () => {
  const lines = [dayStatusLine({ list_at: "2026-03-10T12:30:00Z" }), journalStatusLine([{ n: 3 }]), replayStatusLine("sip", "2026-10-23T14:07:00Z"), replayStatusLine("iex", "2026-10-23T14:07:00Z")];
  for (const line of lines) for (const text of [...line.left, ...line.right]) assert.equal(containsPracticeBannedTerm(text), false, text);
});
