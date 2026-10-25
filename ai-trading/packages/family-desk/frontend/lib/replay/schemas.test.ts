import assert from "node:assert/strict";
import test from "node:test";
import { daysResponse, delta, feed, markResult, session, sessionSummary } from "./fixtures.ts";
import {
  MarkResultSchema,
  MarkUndoSchema,
  ReplayDaysSchema,
  ReplayDeltaSchema,
  ReplayFeedSchema,
  ReplaySessionSchema,
  ReplaySessionsSchema,
} from "./schemas.ts";

test("the plan's payloads parse", () => {
  assert.equal(ReplayDaysSchema.parse(daysResponse).days.length, 3);
  assert.equal(ReplaySessionSchema.parse(session).spec.symbol, "NVDA");
  assert.equal(ReplayDeltaSchema.parse(delta).prints.rows[0]?.[2], 200);
  assert.equal(ReplayFeedSchema.parse(feed).interval, "5m");
  assert.equal(MarkResultSchema.parse(markResult).mark.kind, "long_entry");
});

test("optional API extras may be absent: pace, big_print_usd, window_start", () => {
  const bare = { ...delta, prints: { feed: "sip", rows: [], count: 0, volume: 0, shown: 0 } };
  const parsed = ReplayDeltaSchema.parse(bare);
  assert.equal(parsed.prints.pace, undefined);
  assert.equal(ReplayFeedSchema.parse({ ...bare, interval: "1m" }).window_start, undefined);
});

test("the session list reads as an array from either envelope", () => {
  assert.equal(ReplaySessionsSchema.parse([sessionSummary]).length, 1);
  assert.equal(ReplaySessionsSchema.parse({ sessions: [sessionSummary] })[0]?.symbol, "NVDA");
});

test("undo accepts the new book or an empty answer", () => {
  assert.equal(MarkUndoSchema.parse(undefined), undefined);
  assert.equal(MarkUndoSchema.parse({ removed_mark_id: 3, open_trade: null })?.open_trade, null);
});

test("malformed payloads are rejected", () => {
  assert.equal(ReplayDeltaSchema.safeParse({ ...delta, revealed_through: "yesterday" }).success, false);
  assert.equal(ReplayDeltaSchema.safeParse({ ...delta, prints: { ...delta.prints, rows: [["2026-04-07T14:07:11Z", 188, 100, 2]] } }).success, false);
  assert.equal(ReplayDeltaSchema.safeParse({ ...delta, bars: [{ t: "2026-04-07T14:00:00Z", o: Number.NaN, h: 1, l: 1, c: 1, v: 1 }] }).success, false);
  assert.equal(ReplaySessionSchema.safeParse({ ...session, status: "paused" }).success, false);
  assert.equal(ReplaySessionSchema.safeParse({ ...session, spec: { ...session.spec, shares: 0 } }).success, false);
  assert.equal(ReplaySessionSchema.safeParse({ ...session, stamp: { ...session.stamp, freshness: "live" } }).success, false);
  assert.equal(ReplayDaysSchema.safeParse({ ...daysResponse, days: [{ ...daysResponse.days[0], day: "April 7" }] }).success, false);
});
