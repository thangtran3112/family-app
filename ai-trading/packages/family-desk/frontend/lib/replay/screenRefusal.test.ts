import assert from "node:assert/strict";
import test from "node:test";
import { readScreenRefusal, writeScreenRefusal } from "./screenRefusal.ts";

const memory = () => {
  const items = new Map<string, string>();
  return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) };
};

test("D-239: a refusal written for a thread is read back for that thread only", () => {
  const storage = memory();
  const refusal = { minute: 29_700_000, reason: "Abnormal volume waits until 10:00 AM ET" };
  writeScreenRefusal(storage, 7, refusal);
  assert.deepEqual(readScreenRefusal(storage, 7), refusal);
  assert.equal(readScreenRefusal(storage, 8), null);
});

test("D-239: writing null forgets the refusal", () => {
  const storage = memory();
  writeScreenRefusal(storage, 7, { minute: 1, reason: "x" });
  writeScreenRefusal(storage, 7, null);
  assert.equal(readScreenRefusal(storage, 7), null);
  assert.equal(storage.items.size, 0);
});

test("D-239: a missing, broken or throwing store reads as no refusal and never throws", () => {
  assert.equal(readScreenRefusal(null, 7), null);
  for (const bad of ["", "not json", "null", "42", "{}", '{"minute":"1","reason":"x"}', '{"minute":1}']) {
    const storage = memory();
    storage.items.set("desk.screenRefusal:7", bad);
    assert.equal(readScreenRefusal(storage, 7), null, bad);
  }
  const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  assert.equal(readScreenRefusal(throwing, 7), null);
  assert.doesNotThrow(() => writeScreenRefusal(throwing, 7, { minute: 1, reason: "x" }));
  assert.doesNotThrow(() => writeScreenRefusal(throwing, 7, null));
  assert.doesNotThrow(() => writeScreenRefusal(null, 7, null));
});
