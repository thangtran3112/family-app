import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_QUIET_HOURS,
  QuietHoursSchema,
  mergeOwnedSettings,
  readOwnedSettings,
} from "./schema.ts";

test("quiet hours use strict 24-hour HH:MM values", () => {
  assert.equal(QuietHoursSchema.safeParse({ start: "22:00", end: "07:30" }).success, true);
  assert.equal(QuietHoursSchema.safeParse({ start: "25:00", end: "07:30" }).success, false);
  assert.equal(QuietHoursSchema.safeParse({ start: "7:00", end: "07:30" }).success, false);
});

test("missing channel preferences keep legacy external delivery enabled", () => {
  const owned = readOwnedSettings({});

  assert.deepEqual(owned.quietHours, DEFAULT_QUIET_HOURS);
  assert.deepEqual(owned.channels, { telegram: true, slack: true });
  assert.deepEqual(owned.warnings, []);
});

test("explicit empty channel preferences disable external channels", () => {
  assert.deepEqual(readOwnedSettings({ channels: [] }).channels, { telegram: false, slack: false });
});

test("malformed stored preferences present safe defaults and a repair warning", () => {
  const owned = readOwnedSettings({
    quiet_hours: { start: "25:00", end: "07:00", legacy_note: "keep" },
    channels: ["unknown"],
  });

  assert.deepEqual(owned.quietHours, DEFAULT_QUIET_HOURS);
  assert.deepEqual(owned.channels, { telegram: false, slack: false });
  assert.equal(owned.warnings.length, 2);
});

test("merging owned preferences preserves unknown top-level and quiet-hours keys", () => {
  const stored = {
    custom_setting: { enabled: true },
    quiet_hours: { start: "22:00", end: "07:00", timezone_note: "legacy", extra: { keep: 1 } },
  };

  assert.deepEqual(
    mergeOwnedSettings(stored, {
      quietHours: { start: "21:30", end: "08:00" },
      channels: { telegram: false, slack: true },
    }),
    {
      custom_setting: { enabled: true },
      quiet_hours: { start: "21:30", end: "08:00", timezone_note: "legacy", extra: { keep: 1 } },
      channels: ["inbox", "slack"],
    },
  );
});
