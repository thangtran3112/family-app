import assert from "node:assert/strict";
import test from "node:test";
import { StrategySpecV1Schema } from "@ai-trading/contracts";
import { formToSpec, specToForm, switchToWatchlist } from "./form.ts";
import { STRATEGY_TEMPLATES } from "../templates.ts";

test("symbols-to-watchlist switch chooses sole owned list in the actual spec", () => {
  const form = specToForm(STRATEGY_TEMPLATES[0]!.spec);
  form.watch.universe = { symbols: ["NVDA", "AAPL"] };
  const switched = switchToWatchlist(form, ["Owned list"]);

  assert.deepEqual(switched.watch.universe, { watchlist: "Owned list" });
  assert.equal(switched.watch.session, form.watch.session);
  assert.equal(switched.watch.runOn, form.watch.runOn);
  assert.equal(StrategySpecV1Schema.safeParse(formToSpec(switched)).success, true);
});

test("symbols-to-watchlist switch with no owned lists leaves explicit invalid empty state", () => {
  const form = specToForm(STRATEGY_TEMPLATES[0]!.spec);
  form.watch.universe = { symbols: ["NVDA"] };
  const switched = switchToWatchlist(form, []);

  assert.deepEqual(switched.watch.universe, { watchlist: "" });
  assert.equal(StrategySpecV1Schema.safeParse(formToSpec(switched)).success, false);
});
