import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { todayPositionPreview } from "./today-position.ts";

test("Today fixture exposes three labelled sample levels and no live/order provenance", () => {
  const preview = todayPositionPreview();

  assert.equal(preview.actionNote, "needs broker setup");
  assert.equal(preview.fixtureLabel, "Preview · not connected yet");
  assert.equal(preview.connected, false);
  assert.equal(preview.controlsEnabled, false);
  assert.equal(preview.notice, "Illustrative only; not a connected position, not tied to this chart, and not an order.");
  assert.deepEqual(preview.levels, [
    { label: "Entry", value: "$189.31" },
    { label: "Stop", value: "$188.10" },
    { label: "Target", value: "$196.00" },
  ]);
  assert.equal("quality" in preview, false);
  assert.equal("order" in preview, false);
});

test("fixture UI stays separate from real candles and has no API or active action", () => {
  const chart = readFileSync(new URL("../../components/today/PriceChart.tsx", import.meta.url), "utf8");
  const fixture = readFileSync(new URL("../../components/today/PositionFixture.tsx", import.meta.url), "utf8");
  const chartProps = chart.slice(chart.indexOf("<MarketChart"), chart.indexOf("/>", chart.indexOf("<MarketChart")));

  assert.match(chart, /<PositionFixture\s*\/>/);
  assert.doesNotMatch(chartProps, /\blevels\s*=/);
  assert.match(fixture, /disabled=\{!preview\.controlsEnabled\}/);
  assert.doesNotMatch(fixture, /\b(?:deskFetch|openQuoteStream|fetch)\b|\bon(?:Click|Submit)\s*=/);
});
