import assert from "node:assert/strict";
import test from "node:test";
import { createSingleFlightSettingsSave, settingsControlsDisabled } from "./persistence.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("settings controls stay disabled until loaded and during a save", () => {
  assert.equal(settingsControlsDisabled({ loading: true, saving: false, hasSettings: false }), true);
  assert.equal(settingsControlsDisabled({ loading: false, saving: true, hasSettings: true }), true);
  assert.equal(settingsControlsDisabled({ loading: false, saving: false, hasSettings: false }), true);
  assert.equal(settingsControlsDisabled({ loading: false, saving: false, hasSettings: true }), false);
});

test("a delayed save remains pending and blocks overlapping writes", async () => {
  const save = createSingleFlightSettingsSave();
  const wait = deferred<string>();
  const writes: string[] = [];
  let settled = false;
  const first = save.run(async () => {
    writes.push("first intent");
    return wait.promise;
  });
  void first.then(() => { settled = true; });

  const overlap = await save.run(async () => {
    writes.push("overlapping intent");
    return "stale";
  });
  await Promise.resolve();

  assert.deepEqual(overlap, { status: "busy" });
  assert.deepEqual(writes, ["first intent"]);
  assert.equal(settled, false);

  wait.resolve("server response");
  assert.deepEqual(await first, { status: "saved", value: "server response" });
});

test("failed saves never report saved and release guard for retry", async () => {
  const save = createSingleFlightSettingsSave();

  assert.deepEqual(await save.run(async () => { throw new Error("offline"); }), { status: "error" });
  assert.deepEqual(await save.run(async () => "retry response"), { status: "saved", value: "retry response" });
});

test("an unmounted settings page ignores delayed save completion", async () => {
  const save = createSingleFlightSettingsSave();
  const wait = deferred<string>();
  const pending = save.run(() => wait.promise);

  save.dispose();
  wait.resolve("late response");

  assert.deepEqual(await pending, { status: "disposed" });
});
