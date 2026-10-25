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
import { StampSchema } from "../api/schemas.ts";

test("the plan's payloads parse", () => {
  assert.equal(ReplayDaysSchema.parse(daysResponse).days.length, 3);
  assert.equal(ReplaySessionSchema.parse(session).spec.symbol, "NVDA");
  assert.equal(ReplayDeltaSchema.parse(delta).prints.rows[0]?.[2], 200);
  assert.equal(ReplayFeedSchema.parse(feed).interval, "5m");
  assert.equal(MarkResultSchema.parse(markResult).mark.kind, "long_entry");
});

test("an idle tape parses: no pace, no big-print threshold crossed", () => {
  const quiet = { ...delta, prints: { ...delta.prints, rows: [], count: 0, volume: 0, shown: 0, pace: null } };
  const parsed = ReplayDeltaSchema.parse(quiet);
  assert.equal(parsed.prints.pace, null);
  assert.equal(parsed.prints.big_print_usd, 200000);
});

test("the contract's required fields are required: the feed's interval and window_start, undo's journal", () => {
  assert.equal(ReplayFeedSchema.safeParse({ ...feed, window_start: undefined }).success, false);
  assert.equal(ReplayFeedSchema.safeParse({ ...feed, interval: "30m" }).success, false);
  assert.equal(MarkUndoSchema.safeParse({ removed_mark_id: 3, open_trade: null }).success, false);
  assert.equal(MarkUndoSchema.parse({ removed_mark_id: 3, open_trade: null, journal: markResult.journal }).open_trade, null);
});

test("the session list is a bare array", () => {
  assert.equal(ReplaySessionsSchema.parse([sessionSummary]).length, 1);
  assert.equal(ReplaySessionsSchema.safeParse({ sessions: [sessionSummary] }).success, false);
});

test("every Practice response may carry stamp.freshness replay, and the shared Stamp accepts it too", () => {
  assert.equal(StampSchema.parse({ as_of: "2026-04-07T14:07:00Z", source: "alpaca", quality: "delayed-15m", freshness: "replay" }).freshness, "replay");
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
