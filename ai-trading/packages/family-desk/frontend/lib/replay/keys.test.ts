import assert from "node:assert/strict";
import test from "node:test";
import { actionForKey, isActivatable, isTextField, KEY_LEGEND, layerToClose, SHORTCUT_GROUPS, type OpenSide } from "./keys.ts";

const press = (key: string, side: OpenSide = "flat", extra: Record<string, unknown> = {}, overlay = false) => actionForKey({ key, ...extra }, side, overlay);

test("Space, arrows and digits drive playback in every trade state", () => {
  for (const side of ["flat", "long", "short"] as const) {
    assert.deepEqual(press(" ", side), { type: "toggle_play" });
    assert.deepEqual(press("ArrowRight", side), { type: "step" });
    assert.deepEqual(press("ArrowRight", side, { shiftKey: true }), { type: "next_signal" });
    assert.deepEqual(press("1", side), { type: "speed", speed: 1 });
    assert.deepEqual(press("4", side), { type: "speed", speed: 10 });
    assert.deepEqual(press("n", side), { type: "note" });
    assert.deepEqual(press("?", side), { type: "help" });
    assert.deepEqual(press("Escape", side), { type: "close" });
  }
  assert.equal(press("5"), null);
});

test("B and S are a Buy or a Sell fill whatever is held; X closes the position or says there is none", () => {
  for (const side of ["flat", "long", "short"] as const) {
    assert.deepEqual(press("b", side), { type: "mark", kind: "long_entry" }, `Buy with ${side}`);
    assert.deepEqual(press("S", side), { type: "mark", kind: "short_entry" }, `Sell with ${side}`);
  }
  assert.equal(press("x", "flat")?.type, "blocked");
  assert.deepEqual(press("x", "long"), { type: "mark", kind: "long_exit" });
  assert.deepEqual(press("x", "short"), { type: "mark", kind: "short_exit" });
});

test("T needs an open trade", () => {
  assert.equal(press("t", "flat")?.type, "blocked");
  assert.deepEqual(press("t", "long"), { type: "stop_note" });
});

test("undo is Cmd+Z or Ctrl+Z only; other browser shortcuts pass through", () => {
  assert.deepEqual(press("z", "long", { metaKey: true }), { type: "undo" });
  assert.deepEqual(press("Z", "flat", { ctrlKey: true }), { type: "undo" });
  assert.equal(press("z", "flat", { metaKey: true, shiftKey: true }), null);
  assert.equal(press("r", "flat", { metaKey: true }), null);
  assert.equal(press("b", "flat", { ctrlKey: true }), null);
  assert.equal(press("b", "flat", { altKey: true }), null);
  assert.equal(press("z"), null);
});

test("every key is ignored while typing in a field", () => {
  for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "INPUT", type: "number" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
    for (const key of [" ", "b", "s", "x", "t", "n", "ArrowRight", "1", "?", "Escape"]) assert.equal(actionForKey({ key, target }, "flat"), null, `${key} in ${target.tagName}`);
    assert.equal(actionForKey({ key: "z", metaKey: true, target }, "flat"), null);
  }
  assert.equal(isTextField({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTextField(null), false);
});

test("Space on a button is left to the button; letters still work there", () => {
  const button = { tagName: "BUTTON" };
  assert.equal(actionForKey({ key: " ", target: button }, "flat"), null);
  assert.deepEqual(actionForKey({ key: "b", target: button }, "flat"), { type: "mark", kind: "long_entry" });
  assert.equal(isActivatable({ tagName: "DIV", role: "tab" }), true);
  assert.equal(isActivatable({ tagName: "DIV" }), false);
});

test("with the shortcuts overlay open only ? and Escape count", () => {
  assert.deepEqual(press("?", "flat", {}, true), { type: "help" });
  assert.deepEqual(press("Escape", "flat", {}, true), { type: "close" });
  for (const key of [" ", "b", "n", "ArrowRight", "1"]) assert.equal(press(key, "flat", {}, true), null);
  assert.equal(press("z", "long", { metaKey: true }, true), null);
});

test("every single-letter key in the legend under the timeline drives an action (D-026)", () => {
  const letters = KEY_LEGEND.filter((item) => /^[A-Z]$/.test(item.keys));
  assert.deepEqual(letters.map((item) => item.keys), ["B", "S", "X", "T", "N"]);
  for (const item of letters) assert.notEqual(press(item.keys.toLowerCase(), "long"), null, item.keys);
});

// ---- R-01: full screen (F), Chart settings (C), and the layers Escape closes -------------------------------------

test("F toggles full screen and C opens Chart settings, in every trade state", () => {
  for (const side of ["flat", "long", "short"] as const) {
    assert.deepEqual(press("f", side), { type: "toggle_full" });
    assert.deepEqual(press("F", side), { type: "toggle_full" });
    assert.deepEqual(press("c", side), { type: "chart_settings" });
  }
});

test("F and C pass through with a modifier, in a text field, or while the shortcuts overlay is open", () => {
  for (const extra of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
    assert.equal(press("f", "flat", extra), null, JSON.stringify(extra));
    assert.equal(press("c", "flat", extra), null, JSON.stringify(extra));
  }
  for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "INPUT", type: "number" }, { tagName: "TEXTAREA" }]) {
    assert.equal(actionForKey({ key: "f", target }, "flat"), null);
    assert.equal(actionForKey({ key: "c", target }, "flat"), null);
  }
  assert.equal(press("f", "flat", {}, true), null);
  assert.equal(press("c", "flat", {}, true), null);
});

test("Escape closes the innermost layer first: settings, then the shortcuts, then the composer, then full screen", () => {
  const all = { settings: true, help: true, composer: true, full: true };
  assert.equal(layerToClose(all), "settings");
  assert.equal(layerToClose({ ...all, settings: false }), "help");
  assert.equal(layerToClose({ ...all, settings: false, help: false }), "composer");
  assert.equal(layerToClose({ settings: false, help: false, composer: false, full: true }), "full");
  assert.equal(layerToClose({ settings: false, help: false, composer: false, full: false }), null);
});

test("the ? overlay lists the View keys, and the one-line legend under the timeline is unchanged", () => {
  const view = SHORTCUT_GROUPS.find((group) => group.title === "View");
  assert.deepEqual(view?.rows.map((row) => row.keys), [["F"], ["C"], ["Esc"]]);
  assert.deepEqual(KEY_LEGEND.map((item) => item.keys), ["Space", "B", "S", "X", "T", "N", "⌘Z", "?"]);
});

test("a checkbox or radio inside the settings popover is neither a text field nor activatable (why the popover keeps its keys)", () => {
  for (const type of ["checkbox", "radio"]) {
    assert.equal(isTextField({ tagName: "INPUT", type }), false);
    assert.equal(isActivatable({ tagName: "INPUT", type }), false);
    assert.deepEqual(actionForKey({ key: " ", target: { tagName: "INPUT", type } }, "flat"), { type: "toggle_play" }, "so the popover's own guard has to stop this key");
  }
});
