import assert from "node:assert/strict";
import test from "node:test";
import { STRATEGY_TEMPLATES } from "../templates.ts";
import { applyStrategyContext, parseStrategyContext, strategyContextHref } from "./context.ts";

const templates = STRATEGY_TEMPLATES;

test("parses allowlisted technical-bias context into canonical market and strategy values", () => {
  const context = parseStrategyContext(
    new URLSearchParams("template=technical-bias-change&symbol=%2Fes&timeframe=15m&block=summary"),
    templates,
  );

  assert.equal(context.kind, "ready");
  if (context.kind !== "ready") return;
  assert.equal(context.symbol, "/ES");
  assert.equal(context.template.slug, "technical-bias-change");
  assert.equal(context.runOn, "bar_close_15m");
  const prepared = applyStrategyContext(context);
  assert.equal(prepared.spec.watch.runOn, "bar_close_15m");
  assert.deepEqual(prepared.spec.watch.universe, { symbols: ["/ES"] });
  assert.deepEqual(prepared.spec.when, templates.find(({ slug }) => slug === "technical-bias-change")?.spec.when);
});

test("RSI row context selects shipped RSI template and retains its authored condition", () => {
  const context = parseStrategyContext(
    new URLSearchParams("template=technical-bias-change&symbol=aapl&timeframe=1D&block=rsi"),
    templates,
  );

  assert.equal(context.kind, "ready");
  if (context.kind !== "ready") return;
  assert.equal(context.template.slug, "rsi-reversal");
  assert.equal(context.symbol, "AAPL");
  assert.equal(context.runOn, "daily_close");
  const prepared = applyStrategyContext(context);
  assert.equal(prepared.spec.watch.runOn, "daily_close");
  assert.deepEqual(prepared.spec.when, templates.find(({ slug }) => slug === "rsi-reversal")?.spec.when);
});

test("unsupported timeframe, block, or template remains explicit and produces no preset", () => {
  for (const query of [
    "template=technical-bias-change&symbol=AAPL&timeframe=30m&block=summary",
    "template=technical-bias-change&symbol=AAPL&timeframe=15m&block=unknown",
    "template=not-shipped&symbol=AAPL&timeframe=15m&block=summary",
    "template=technical-bias-change&symbol=AAPL&timeframe=15m&block=summary&extra=value",
  ]) {
    const context = parseStrategyContext(new URLSearchParams(query), templates);
    assert.equal(context.kind, "unsupported");
    if (context.kind === "unsupported") assert.ok(context.reasons.length > 0);
  }
});

test("card strategy context keeps encoded future identity in the URL", () => {
  assert.equal(
    strategyContextHref("/ES", "15m", "summary"),
    "/strategies/new?template=technical-bias-change&symbol=%2FES&timeframe=15m&block=summary",
  );
});
