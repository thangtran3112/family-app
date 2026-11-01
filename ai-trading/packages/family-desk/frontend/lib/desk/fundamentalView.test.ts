import assert from "node:assert/strict";
import test from "node:test";
import { loadFundamentalFixture } from "../fixtures/desk-fundamental/load.ts";
import { HoldingsSchema, ImportStateSchema } from "../api/fundamentalSchemas.ts";
import { containsBannedTerm } from "./freshness.ts";
import { hasHoldingsData, importLine, ratingText, setupLinkParts } from "./fundamentalView.ts";

const base = { source: "ibkr_flex", account_scope: "data", statement_date: "2026-10-23", imported_at: "2026-10-24T09:15:00Z", lots: 21, state: "ok" } as const;

test("the import line follows the §b4 copy rows", () => {
  assert.deepEqual(importLine(ImportStateSchema.parse(base)), { text: "Holdings as of Fri 2026-10-23 close · IBKR Flex · 21 lots", tone: "up" });
  assert.equal(importLine({ ...base, lots: 1 }).text, "Holdings as of Fri 2026-10-23 close · IBKR Flex · 1 lot");
  assert.deepEqual(importLine({ ...base, state: "running" }), { text: "Importing holdings…", tone: "neutral" });
  assert.deepEqual(importLine({ ...base, state: "failed", statement_date: "2026-10-22" }), { text: "Couldn't import holdings · showing Thu 2026-10-22 · Try again", tone: "warn" });
  assert.equal(importLine({ ...base, state: "failed", statement_date: null }).text, "Couldn't import holdings · Try again");
  assert.deepEqual(importLine({ ...base, state: "not_configured", statement_date: null, lots: 0 }), { text: "Holdings aren't connected yet · set up the IBKR import in Settings", tone: "neutral" });
  assert.deepEqual(importLine({ ...base, state: "none", statement_date: null, lots: 0 }), { text: "No holdings imported for you", tone: "neutral" });
});

test("holdings data exists after a good import or a failed one with an older statement", () => {
  assert.equal(hasHoldingsData({ ...base }), true);
  assert.equal(hasHoldingsData({ ...base, state: "failed" }), true);
  assert.equal(hasHoldingsData({ ...base, state: "failed", statement_date: null }), false);
  assert.equal(hasHoldingsData({ ...base, state: "not_configured", statement_date: null }), false);
});

test("the frozen holdings fixture parses and its import line is clean", () => {
  const holdings = HoldingsSchema.parse(loadFundamentalFixture("holdings"));
  assert.equal(containsBannedTerm(importLine(holdings.import).text), false);
  assert.equal(ratingText("buy"), "Buy");
});

test("the not-connected sentence splits so the setup step can be a link to Settings; other lines stay plain text", () => {
  const parts = setupLinkParts(importLine({ ...base, state: "not_configured", statement_date: null, lots: 0 }).text);
  assert.deepEqual(parts, { lead: "Holdings aren't connected yet · ", link: "set up the IBKR import in Settings", href: "/settings" });
  assert.equal(`${parts?.lead}${parts?.link}`, "Holdings aren't connected yet · set up the IBKR import in Settings");
  assert.equal(setupLinkParts(importLine({ ...base, state: "none", statement_date: null, lots: 0 }).text), null);
  assert.equal(setupLinkParts(importLine({ ...base, state: "running" }).text), null);
});
