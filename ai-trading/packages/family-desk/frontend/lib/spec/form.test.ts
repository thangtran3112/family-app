import assert from "node:assert/strict";
import test from "node:test";
import { StrategySpecV1Schema, type StrategySpecV1 } from "@ai-trading/contracts";
import { formToSpec, groupSpecErrors, specToForm } from "./form.ts";
import { STRATEGY_TEMPLATES } from "../templates.ts";

test("form conversion round-trips every shipped strategy template", () => {
  assert.equal(STRATEGY_TEMPLATES.length, 11);
  for (const { slug, spec } of STRATEGY_TEMPLATES) {
    assert.deepEqual(formToSpec(specToForm(spec)), spec, slug);
  }
});

test("editing nested conditions, series parameters, actions, and limits changes only intended fields", () => {
  const original: StrategySpecV1 = {
    schemaVersion: 1,
    name: "RSI watch",
    watch: { universe: { symbols: ["NVDA"] }, session: "regular", runOn: "bar_close_5m" },
    when: {
      all: [
        { op: "gte", left: { series: "rsi", length: 14 }, right: { value: 50 } },
        { not: { op: "time_between", start: "09:30", end: "10:00" } },
      ],
    },
    then: {
      alert: { channels: ["inbox"], severity: "opportunity" },
      paperOrder: {
        side: "buy",
        size: { shares: 10 },
        stop: { atrMultiple: 2 },
        target: { r: 3 },
      },
    },
    limits: { maxTradesPerDay: 2, flatBy: "15:50" },
  };
  const form = specToForm(original);
  form.name = "Edited RSI watch";
  form.watch.runOn = "bar_close_15m";
  if (!("all" in form.when)) assert.fail("expected all-condition template");
  const first = form.when.all[0];
  if (!("left" in first) || !("series" in first.left) || first.left.series !== "rsi") {
    assert.fail("expected RSI comparison");
  }
  first.left.length = 21;
  form.then.alert.channels.push("telegram");
  form.then.paperOrder!.size = { shares: 20 };
  form.limits!.maxTradesPerDay = 3;

  assert.deepEqual(formToSpec(form), {
    ...original,
    name: "Edited RSI watch",
    watch: { ...original.watch, runOn: "bar_close_15m" },
    when: {
      all: [
        { op: "gte", left: { series: "rsi", length: 21 }, right: { value: 50 } },
        { not: { op: "time_between", start: "09:30", end: "10:00" } },
      ],
    },
    then: {
      alert: { channels: ["inbox", "telegram"], severity: "opportunity" },
      paperOrder: { ...original.then.paperOrder!, size: { shares: 20 } },
    },
    limits: { maxTradesPerDay: 3, flatBy: "15:50" },
  });
  assert.equal(original.name, "RSI watch");
  assert.equal(StrategySpecV1Schema.safeParse(formToSpec(form)).success, true);
});

test("invalid non-finite values, times, and limits are grouped under their form blocks", () => {
  const form = specToForm(STRATEGY_TEMPLATES[0]!.spec);
  form.name = "";
  form.when = {
    all: [
      { op: "within_pct", left: { value: 1 }, right: { value: 2 }, pct: Number.NaN },
      { op: "time_between", start: "25:00", end: "09:30" },
      { op: "gte", left: { series: "close" }, right: { value: Number.POSITIVE_INFINITY } },
    ],
  };
  form.then.alert.channels = ["inbox"];
  form.limits = { flatBy: "25:00", maxTradesPerDay: 13 };

  const result = StrategySpecV1Schema.safeParse(formToSpec(form));
  assert.equal(result.success, false);
  if (result.success) return;
  const errors = groupSpecErrors(result.error);
  assert.ok(errors.Watch?.some(({ path }) => path === "name"));
  assert.ok(errors.When?.some(({ path }) => path === "when.all.0.pct"));
  assert.ok(errors.When?.some(({ path }) => path === "when.all.1.start"));
  assert.ok(errors.When?.some(({ path }) => path === "when.all.2.right.value"));
  assert.ok(errors.Limits?.some(({ path }) => path === "limits.flatBy"));
  assert.ok(errors.Limits?.some(({ path }) => path === "limits.maxTradesPerDay"));
});

test("fractional integer fields surface precise Zod paths in every affected block", () => {
  const form = specToForm(STRATEGY_TEMPLATES[0]!.spec);
  form.limits = { maxTradesPerDay: 1.5 };
  form.when = {
    op: "gte",
    left: { series: "rsi", length: 14.5 },
    right: { value: 50 },
  };
  form.then.paperOrder = {
    side: "buy",
    size: { shares: 1.5 },
    stop: { atrMultiple: 2 },
    target: { r: 2 },
  };

  const result = StrategySpecV1Schema.safeParse(formToSpec(form));
  assert.equal(result.success, false);
  if (result.success) return;
  const errors = groupSpecErrors(result.error);
  assert.ok(errors.Limits?.some(({ path }) => path === "limits.maxTradesPerDay"));
  assert.ok(errors.When?.some(({ path }) => path === "when.left.length"));
  assert.ok(errors.Then?.some(({ path }) => path === "then.paperOrder.size.shares"));
  assert.equal(errors.Then?.some(({ path }) => path === "then.paperOrder.size.contracts"), false);
  assert.ok(Object.values(errors).some((items) => items?.length));
});

test("an invalid form always has a block-level error fallback", () => {
  const form = specToForm(STRATEGY_TEMPLATES[0]!.spec);
  form.name = undefined as unknown as string;
  const result = StrategySpecV1Schema.safeParse(formToSpec(form));
  assert.equal(result.success, false);
  if (result.success) return;
  assert.ok(groupSpecErrors(result.error).Watch?.length);
});
