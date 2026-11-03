import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { journalStatusLine, replayStatusLine, screenStatusLine } from "./statusLine.ts";

const scan = (asOf: string) => ({ seq: 1, as_of: asOf, data_through: "2026-03-10T13:17:00Z", new_count: 0, created_at: asOf });
const SCREEN = { rescan: scan("2026-03-10T12:30:00Z") };

test("D-043: the Screen says where prices come from, that the scan runs at the thread clock, and when it ran", () => {
  const line = screenStatusLine(SCREEN);
  assert.deepEqual(line.left, ["Prices: Alpaca SIP · past days", "The scan runs at the thread clock"]);
  assert.deepEqual(line.right, ["Scanned 8:30 AM ET", "Would-fire signals only · nothing is delivered"]);
});

test("D-165: after a re-scan the status line gives the scan's clock as the one scan time; before the first scan it says none ran", () => {
  assert.equal(screenStatusLine({ rescan: scan("2026-03-10T13:32:00Z") }).right[0], "Scanned 9:32 AM ET");
  assert.equal(screenStatusLine({ rescan: null }).right[0], "Not scanned yet");
});

test("the thread journal says it is read live and which ET date the balance stands at", () => {
  assert.deepEqual(journalStatusLine([{ day: "2026-10-21" }, { day: "2026-10-23" }]), {
    left: ["Prices: Alpaca SIP · past days", "Journal is read live, by ET date"],
    right: ["Balance as of 2026-10-23", "Would-fire signals only · nothing is delivered"],
  });
  assert.equal(journalStatusLine([]).right[0], "Balance at the start · no trade yet");
});

test("the replay line names the lane's own feed and the replay clock", () => {
  const sip = replayStatusLine("sip", "2026-10-23T14:07:00Z");
  assert.deepEqual(sip.left, ["Prices: Alpaca SIP · replay", "Consolidated tape · all US exchanges"]);
  assert.equal(sip.right[0], "Replay clock 10:07:00 AM ET");
  assert.equal(replayStatusLine("iex", "2026-10-23T14:07:00Z").left[0], "Prices: Alpaca IEX · replay", "an IEX lane never claims SIP");
});

test("no status line carries a banned term", () => {
  const lines = [screenStatusLine(SCREEN), journalStatusLine([{ day: "2026-10-23" }]), replayStatusLine("sip", "2026-10-23T14:07:00Z"), replayStatusLine("iex", "2026-10-23T14:07:00Z")];
  for (const line of lines) for (const text of [...line.left, ...line.right]) assert.equal(containsPracticeBannedTerm(text), false, text);
});
