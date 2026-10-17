import assert from "node:assert/strict";
import test from "node:test";
import { StrategySpecV1Schema } from "@ai-trading/contracts";
import { symbolsFromDraft, symbolsToDraft } from "./symbols.ts";
import { STRATEGY_TEMPLATES } from "../templates.ts";

test("symbol draft parser keeps commas and trailing empty tokens during incremental typing", () => {
  let draft = "SPY";
  const states: string[][] = [];
  for (const character of ",QQQ") {
    draft += character;
    const symbols = symbolsFromDraft(draft);
    states.push(symbols);
    draft = symbolsToDraft(symbols);
  }

  assert.deepEqual(states, [["SPY", ""], ["SPY", "Q"], ["SPY", "QQ"], ["SPY", "QQQ"]]);
});

test("invalid symbol drafts remain schema-invalid and cannot be saved", () => {
  const template = STRATEGY_TEMPLATES[0]!.spec;
  for (const draft of ["SPY,", "SPY,bad!"]) {
    const spec = {
      ...template,
      watch: { ...template.watch, universe: { symbols: symbolsFromDraft(draft) } },
    };
    assert.equal(StrategySpecV1Schema.safeParse(spec).success, false, draft);
  }
});

test("symbols formatter preserves Backspace edits through separator removal and clear", () => {
  const roundTrip = (draft: string) => symbolsToDraft(symbolsFromDraft(draft));
  let draft = roundTrip("SPY,QQQ");
  assert.equal(draft, "SPY,QQQ");
  for (const expected of ["SPY,QQ", "SPY,Q", "SPY,"]) {
    draft = roundTrip(draft.slice(0, -1));
    assert.equal(draft, expected);
  }
  draft = roundTrip(draft.slice(0, -1));
  assert.equal(draft, "SPY");

  assert.equal(roundTrip(roundTrip("SPY,").slice(0, -1)), "SPY");
  assert.equal(roundTrip(""), "");
  draft = roundTrip("SPY");
  assert.equal(draft, "SPY");
  assert.equal(StrategySpecV1Schema.safeParse({
    ...STRATEGY_TEMPLATES[0]!.spec,
    watch: { ...STRATEGY_TEMPLATES[0]!.spec.watch, universe: { symbols: symbolsFromDraft("SPY,") } },
  }).success, false);
  assert.equal(StrategySpecV1Schema.safeParse({
    ...STRATEGY_TEMPLATES[0]!.spec,
    watch: { ...STRATEGY_TEMPLATES[0]!.spec.watch, universe: { symbols: symbolsFromDraft(draft) } },
  }).success, true);
});
