import assert from "node:assert/strict";
import test from "node:test";
import { journal, openTrade } from "./fixtures.ts";
import { maxLossReached, planChecklist, practicePnl, tradeCount } from "./planView.ts";
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

test("the checklist ticks live and lists only the plan's rules", () => {
  const items = planChecklist({ stopRequired: "yes", signalOnly: "yes", maxLossUsd: 50, maxTrades: 3 }, parsedJournal, open);
  assert.deepEqual(items.map((item) => [item.id, item.state, item.detail]), [
    ["stop", "warn", "3 of 4"],
    ["signal", "warn", "1 of 3"],
    ["max_loss", "ok", "+$51.00 so far"],
    ["max_trades", "warn", "4 of 3"],
  ]);
  const quiet = planChecklist({ stopRequired: "no", signalOnly: "no" }, { trades: [] }, null);
  assert.deepEqual(quiet, []);
  const fresh = planChecklist({ stopRequired: "yes", signalOnly: "no", maxLossUsd: 100 }, { trades: [] }, null);
  assert.deepEqual(fresh.map((item) => [item.id, item.state]), [["stop", "pending"], ["max_loss", "ok"]]);
  assert.equal(fresh[1]?.label, "Max loss $100.00");
  const hit = planChecklist({ stopRequired: "no", signalOnly: "no", maxLossUsd: 10 }, parsedJournal, null);
  assert.equal(hit[0]?.state, "warn");
});
