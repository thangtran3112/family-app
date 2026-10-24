import assert from "node:assert/strict";
import test from "node:test";
import { isSearchShortcut, moveActive, symbolHref } from "./listNav.ts";

test("moveActive steps and wraps at both ends", () => {
  assert.equal(moveActive(0, "ArrowDown", 3), 1);
  assert.equal(moveActive(2, "ArrowDown", 3), 0);
  assert.equal(moveActive(0, "ArrowUp", 3), 2);
  assert.equal(moveActive(1, "ArrowUp", 3), 0);
  assert.equal(moveActive(-1, "ArrowDown", 3), 0);
  assert.equal(moveActive(-1, "ArrowUp", 3), 2);
});

test("moveActive jumps to the first and last item", () => {
  assert.equal(moveActive(1, "Home", 3), 0);
  assert.equal(moveActive(0, "End", 3), 2);
});

test("moveActive has nothing to move through when the list is empty", () => {
  assert.equal(moveActive(-1, "ArrowDown", 0), -1);
  assert.equal(moveActive(0, "End", 0), -1);
});

test("isSearchShortcut accepts Cmd or Ctrl with K only", () => {
  assert.equal(isSearchShortcut({ key: "k", metaKey: true, ctrlKey: false }), true);
  assert.equal(isSearchShortcut({ key: "K", metaKey: false, ctrlKey: true }), true);
  assert.equal(isSearchShortcut({ key: "k", metaKey: false, ctrlKey: false }), false);
  assert.equal(isSearchShortcut({ key: "j", metaKey: true, ctrlKey: false }), false);
});

test("symbolHref opens the chart for a symbol", () => {
  assert.equal(symbolHref("NVDA"), "/technicals?symbol=NVDA#chart");
  assert.equal(symbolHref("BRK.B"), "/technicals?symbol=BRK.B#chart");
});
