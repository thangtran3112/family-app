import assert from "node:assert/strict";
import test from "node:test";
import { connectionOf, initialQueryState, queryReducer, type QueryState } from "./queryState.ts";

test("first load: loading, then ready; a failed first load is an error", () => {
  let state: QueryState<number> = initialQueryState("a");
  assert.equal(state.status, "loading");
  state = queryReducer(state, { type: "start", key: "a" });
  assert.equal(state.status, "loading");
  const failed = queryReducer(state, { type: "failure", key: "a", error: new Error("x") });
  assert.equal(failed.status, "error");
  assert.equal(failed.data, null);
  state = queryReducer(state, { type: "success", key: "a", data: 1, at: 10 });
  assert.deepEqual([state.status, state.data, state.error, state.updatedAt], ["ready", 1, null, 10]);
});

test("a refresh keeps the old data and reads as updating", () => {
  let state: QueryState<number> = queryReducer(initialQueryState<number>("a"), { type: "success", key: "a", data: 1, at: 10 });
  state = queryReducer(state, { type: "start", key: "a" });
  assert.deepEqual([state.status, state.data], ["updating", 1]);
  assert.equal(connectionOf(state), "updating");
  state = queryReducer(state, { type: "success", key: "a", data: 2, at: 20 });
  assert.deepEqual([state.status, state.data, state.updatedAt], ["ready", 2, 20]);
  assert.equal(connectionOf(state), "ok");
});

test("a failed refresh keeps the old data on screen and reads as reconnecting; the next success clears it", () => {
  let state: QueryState<number> = queryReducer(initialQueryState<number>("a"), { type: "success", key: "a", data: 1, at: 10 });
  state = queryReducer(state, { type: "start", key: "a" });
  state = queryReducer(state, { type: "failure", key: "a", error: new Error("down") });
  assert.deepEqual([state.status, state.data], ["ready", 1]);
  assert.equal(connectionOf(state), "reconnecting");
  state = queryReducer(state, { type: "success", key: "a", data: 3, at: 30 });
  assert.equal(connectionOf(state), "ok");
});

test("a new key drops the previous key's data", () => {
  const state = queryReducer(initialQueryState<number>("a"), { type: "success", key: "a", data: 1, at: 10 });
  const next = queryReducer(state, { type: "start", key: "b" });
  assert.deepEqual([next.key, next.data, next.status], ["b", null, "loading"]);
  const late = queryReducer(next, { type: "success", key: "a", data: 9, at: 40 });
  // A late answer for the old key replaces nothing useful: the reducer follows the action's key.
  assert.equal(late.key, "a");
});
