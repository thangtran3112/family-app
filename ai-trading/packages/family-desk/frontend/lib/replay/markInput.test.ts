import assert from "node:assert/strict";
import test from "node:test";
import { entryMark, exitMark, markForAction, noteMark, stopMark } from "./markInput.ts";

test("entries carry shares and a stop only when typed", () => {
  assert.deepEqual(entryMark("long_entry", {}), { ok: true, mark: { schemaVersion: 1, kind: "long_entry" } });
  assert.deepEqual(entryMark("short_entry", { shares: "50", stopPrice: "188.5", note: " ORB fade " }), {
    ok: true,
    mark: { schemaVersion: 1, kind: "short_entry", shares: 50, stopPrice: 188.5, note: "ORB fade" },
  });
  assert.deepEqual(entryMark("long_entry", { shares: "  ", stopPrice: "" }), { ok: true, mark: { schemaVersion: 1, kind: "long_entry" } });
});

test("bad fields give plain sentences", () => {
  assert.deepEqual(entryMark("long_entry", { shares: "0" }), { ok: false, message: "Quantity: a whole number of 1 or more" });
  assert.deepEqual(entryMark("long_entry", { shares: "2.5" }), { ok: false, message: "Quantity: a whole number of 1 or more" });
  assert.deepEqual(entryMark("long_entry", { stopPrice: "-1" }), { ok: false, message: "Stop price: a number above 0" });
  assert.deepEqual(entryMark("long_entry", { stopPrice: "abc" }), { ok: false, message: "Stop price: a number above 0" });
  assert.deepEqual(stopMark(""), { ok: false, message: "Stop price: a number above 0" });
  assert.deepEqual(noteMark("   "), { ok: false, message: "Note: 1 to 280 plain characters" });
  assert.equal(noteMark("x".repeat(281)).ok, false);
});

test("exits, stops and notes build their contract kinds", () => {
  assert.deepEqual(exitMark("long_exit"), { ok: true, mark: { schemaVersion: 1, kind: "long_exit" } });
  assert.deepEqual(exitMark("short_exit", { note: "took it" }), { ok: true, mark: { schemaVersion: 1, kind: "short_exit", note: "took it" } });
  assert.deepEqual(stopMark("186.9"), { ok: true, mark: { schemaVersion: 1, kind: "stop", stopPrice: 186.9 } });
  assert.deepEqual(noteMark("chop"), { ok: true, mark: { schemaVersion: 1, kind: "note", note: "chop" } });
});

test("a key action reads the shares and stop fields for entries only", () => {
  assert.deepEqual(markForAction("long_entry", { shares: "10", stopPrice: "1" }), { ok: true, mark: { schemaVersion: 1, kind: "long_entry", shares: 10, stopPrice: 1 } });
  assert.deepEqual(markForAction("long_exit", { shares: "10", stopPrice: "1" }), { ok: true, mark: { schemaVersion: 1, kind: "long_exit" } });
});
