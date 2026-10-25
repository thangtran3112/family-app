import assert from "node:assert/strict";
import test from "node:test";
import { addMs, etDayOf, etHhMm, etTapeClock, etWallToUtcIso } from "./time.ts";

test("ET wall clock becomes UTC with the offset in force on that day", () => {
  assert.equal(etWallToUtcIso("2026-10-23", "10:15"), "2026-10-23T14:15:00.000Z"); // EDT, UTC-4
  assert.equal(etWallToUtcIso("2026-01-15", "09:30"), "2026-01-15T14:30:00.000Z"); // EST, UTC-5
});

test("the DST change days use the offset true at the answer itself", () => {
  // 2026-03-08: clocks jump at 02:00 EST (07:00Z), so 10:00 is already EDT and 01:30 is still EST.
  assert.equal(etWallToUtcIso("2026-03-08", "10:00"), "2026-03-08T14:00:00.000Z");
  assert.equal(etWallToUtcIso("2026-03-08", "01:30"), "2026-03-08T06:30:00.000Z");
  // 2026-11-01: clocks fall back at 02:00 EDT (06:00Z), so 00:30 is EDT and 10:00 is EST.
  assert.equal(etWallToUtcIso("2026-11-01", "00:30"), "2026-11-01T04:30:00.000Z");
  assert.equal(etWallToUtcIso("2026-11-01", "10:00"), "2026-11-01T15:00:00.000Z");
});

test("malformed day or time inputs give null", () => {
  assert.equal(etWallToUtcIso("2026-10-23", "25:00"), null);
  assert.equal(etWallToUtcIso("2026-10-23", "10:60"), null);
  assert.equal(etWallToUtcIso("2026-10-23", "9:30"), null);
  assert.equal(etWallToUtcIso("10/23/2026", "10:15"), null);
});

test("an instant reads back as ET wall-clock time, tape clock and day", () => {
  assert.equal(etHhMm("2026-10-23T14:07:00Z"), "10:07");
  assert.equal(etHhMm("2026-01-15T14:30:00Z"), "09:30");
  assert.equal(etHhMm("2026-10-23T04:00:00Z"), "00:00", "ET midnight is 00:00, never 24:00");
  assert.equal(etTapeClock("2026-10-23T14:07:11.482Z"), "10:07:11");
  assert.equal(etTapeClock("2026-01-15T14:30:05Z"), "09:30:05");
});

test("the ET calendar day flips at ET midnight, not UTC midnight", () => {
  // EDT midnight is 04:00Z; EST midnight is 05:00Z.
  assert.equal(etDayOf("2026-10-23T03:59:59Z"), "2026-10-22");
  assert.equal(etDayOf("2026-10-23T04:00:00Z"), "2026-10-23");
  assert.equal(etDayOf("2026-01-15T04:59:59Z"), "2026-01-14");
  assert.equal(etDayOf("2026-01-15T05:00:00Z"), "2026-01-15");
});

test("addMs moves an ISO instant and always answers with milliseconds", () => {
  assert.equal(addMs("2026-10-23T14:07:00Z", 60_000), "2026-10-23T14:08:00.000Z");
  assert.equal(addMs("2026-10-23T14:07:00Z", -1000), "2026-10-23T14:06:59.000Z");
  assert.equal(addMs("2026-10-23T14:07:11.482Z", 518), "2026-10-23T14:07:12.000Z");
});
