import assert from "node:assert/strict";
import test from "node:test";
import { journal, openTrade } from "./fixtures.ts";
import { formatClock } from "../desk/format.ts";
import { maxLossReached, planChecklist, planNote, practicePnl, sessionFacts, tradeCount } from "./planView.ts";
import { JournalSchema, OpenTradeSchema } from "./schemas.ts";

const parsedJournal = JournalSchema.parse(journal);
const open = OpenTradeSchema.parse(openTrade);

test("practice P/L is closed trades plus the open trade marked now", () => {
  assert.equal(practicePnl(parsedJournal, null), -12);
  assert.equal(practicePnl(parsedJournal, open), 51);
  assert.equal(practicePnl({ trades: [] }, null), 0);
  assert.equal(tradeCount(parsedJournal, open), 4);
  assert.equal(tradeCount({ trades: [] }, null), 0);
});

test("max loss is a warning at or below the limit", () => {
  assert.equal(maxLossReached(-200, { maxLossUsd: 200 }), true);
  assert.equal(maxLossReached(-199.99, { maxLossUsd: 200 }), false);
  assert.equal(maxLossReached(-5000, {}), false);
});

test("the checklist ticks live and has a row for every rule of the plan", () => {
  const items = planChecklist({ stopRequired: "yes", signalOnly: "yes", maxLossUsd: 50, maxTrades: 3 }, parsedJournal, open);
  assert.deepEqual(items.map((item) => [item.id, item.state, item.detail]), [
    ["stop", "warn", "3 of 4"],
    ["signal", "warn", "1 of 3"],
    ["max_loss", "ok", "+$51.00 so far"],
    ["max_trades", "warn", "4 of 3"],
  ]);
  const fresh = planChecklist({ stopRequired: "yes", signalOnly: "no", maxLossUsd: 100 }, { trades: [] }, null);
  assert.deepEqual(fresh.map((item) => [item.id, item.state, item.detail]), [
    ["stop", "pending", "No trades yet"],
    ["signal", "off", "Off"],
    ["max_loss", "ok", "$0.00 so far"],
    ["max_trades", "off", "None"],
  ]);
  assert.equal(fresh[2]?.label, "Max loss $100.00");
  const hit = planChecklist({ stopRequired: "no", signalOnly: "no", maxLossUsd: 10 }, parsedJournal, null);
  assert.equal(hit.find((item) => item.id === "max_loss")?.state, "warn");
});

test("D-021: a plan with no rules still lists all four, reading Off and None", () => {
  const quiet = planChecklist({ stopRequired: "no", signalOnly: "no" }, { trades: [] }, null);
  assert.deepEqual(quiet.map((item) => [item.label, item.state, item.detail]), [
    ["Stop note on every entry", "off", "Off"],
    ["Trade only on a signal", "off", "Off"],
    ["Max loss", "off", "None"],
    ["Max trades", "off", "None"],
  ]);
  assert.equal(planNote({ note: "Trade only VWAP reclaims." }), "Trade only VWAP reclaims.");
  assert.equal(planNote({}), null);
});

test("a missing stop is a tick on the checklist and nothing else: no action, no refusal", () => {
  const plan = { stopRequired: "yes", signalOnly: "no" } as const;
  const bare = { ...open, stop_price: null };
  const item = planChecklist(plan, { trades: [] }, bare)[0]!;
  assert.deepEqual([item.state, item.detail], ["warn", "0 of 1"]);
  assert.equal("action" in item, false);
  const done = planChecklist(plan, { trades: [] }, { ...open, stop_price: 9.5 })[0]!;
  assert.deepEqual([done.state, done.detail], ["ok", "1 of 1"]);
  const closedOnly = planChecklist(plan, { trades: [{ ...parsedJournal.trades[0]!, stop_price: null }] }, null)[0]!;
  assert.equal(closedOnly.state, "warn");
});


test("the session block names the symbol, the window and the candle interval with the tape's feed", () => {
  assert.equal(formatClock("09:30"), "9:30 AM");
  assert.equal(formatClock("16:00"), "4:00 PM");
  assert.equal(formatClock("12:05"), "12:05 PM");
  assert.equal(formatClock("00:15"), "12:15 AM");
  const spec = { symbol: "NVDA", window: { from: "09:30", to: "16:00" }, session: "regular", interval: "5m" } as const;
  assert.deepEqual(sessionFacts(spec, 1, "sip").map((row) => [row.label, row.value]), [
    ["Symbol · attempt", "NVDA · attempt 1"],
    ["Window (regular)", "9:30 AM – 4:00 PM ET"],
    ["Interval · tape", "5m · consolidated"],
  ]);
  assert.equal(sessionFacts(spec, 2, "iex")[2]?.value, "5m · IEX only");
  assert.equal(sessionFacts(spec, 2, null)[2]?.value, "5m");
});
