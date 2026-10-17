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
