import assert from "node:assert/strict";
import test from "node:test";
import { journal, openTrade } from "./fixtures.ts";
import { practicePnl, tradeCount } from "./planView.ts";
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
