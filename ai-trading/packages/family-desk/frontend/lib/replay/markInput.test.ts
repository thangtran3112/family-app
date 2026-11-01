import assert from "node:assert/strict";
import test from "node:test";
import { entryMark, exitMark, markForAction, noteMark, SHARES_TOO_BIG, stopMark } from "./markInput.ts";

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

test("a price is plain decimals: hex, exponent and Infinity are refused, not read by Number()", () => {
  for (const text of ["0x10", "1e2", "Infinity", "1,5", "--1", "1.2.3"]) {
    assert.deepEqual(stopMark(text), { ok: false, message: "Stop price: a number above 0" }, text);
  }
  assert.deepEqual(stopMark("  186.90 "), { ok: true, mark: { schemaVersion: 1, kind: "stop", stopPrice: 186.9 } });
  assert.deepEqual(stopMark(".5"), { ok: true, mark: { schemaVersion: 1, kind: "stop", stopPrice: 0.5 } });
});

test("a quantity past the 32-bit column says where the top is, not \"1 or more\"", () => {
  assert.deepEqual(entryMark("long_entry", { shares: "2147483648" }), { ok: false, message: SHARES_TOO_BIG });
  assert.equal(entryMark("long_entry", { shares: "2147483647" }).ok, true);
});
