import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TONES } from "../../components/ui/tone.ts";
import { signTone } from "./format.ts";
import { bannerRole, buttonState, countText, deltaView, factColumns, fieldWiring, formBarStatus, iconA11y, modeLabel, panelHeadingTag, railRowKind, queryView, railRowSelection, requirementText, retryLabel, rovingStop, rovingTarget, statTileTag, tabDomIds, UNSAVED_TEXT } from "./primitivesView.ts";
import { warnBeforeUnload } from "./unsavedGuard.ts";

test("tone: every tone has a colour in globals.css, and a sign maps onto the model", () => {
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  for (const tone of TONES) assert.match(css, new RegExp(`\\[data-tone="${tone}"\\]\\s*\\{\\s*--tone:`), tone);
  assert.deepEqual([signTone(1.2), signTone(-0.4), signTone(0), signTone(null), signTone(Number.NaN)], ["up", "down", "neutral", "neutral", "neutral"]);
});

test("Button: loading disables the button and marks it busy; idle sets nothing", () => {
  assert.deepEqual(buttonState({ loading: true }), { disabled: true, "aria-busy": true });
  assert.deepEqual(buttonState({ disabled: true }), { disabled: true, "aria-busy": undefined });
  assert.deepEqual(buttonState({}), { disabled: false, "aria-busy": undefined });
});

test("Badge: a count stops at 9+ and never prints a negative or a fraction", () => {
  assert.deepEqual([countText(1), countText(9), countText(10), countText(120), countText(-3), countText(2.8)], ["1", "9", "9+", "9+", "0", "2"]);
});

test("Delta: the text carries the sign, the tone follows it, and an explicit tone wins", () => {
  assert.deepEqual(deltaView(2.14), { text: "+2.14%", tone: "up" });
  assert.deepEqual(deltaView(-0.87), { text: "−0.87%", tone: "down" });
  assert.deepEqual(deltaView(0), { text: "0.00%", tone: "neutral" });
  assert.deepEqual(deltaView(null), { text: "—", tone: "neutral" });
  assert.deepEqual(deltaView(3, "ratio", "ai"), { text: "3.00×", tone: "ai" });
});

test("Banner: a failure is an alert, everything else a status", () => {
  assert.deepEqual(TONES.map(bannerRole), ["status", "alert", "status", "status", "status"]);
});

test("StatTile: a tile with an href is a link, a read-only one is not", () => {
  assert.deepEqual([statTileTag("/technicals?symbol=SPY"), statTileTag(undefined), statTileTag("")], ["a", "div", "div"]);
});

test("Panel: the title is an h2 unless asked for h3 or h4", () => {
  assert.deepEqual([panelHeadingTag(undefined), panelHeadingTag(3), panelHeadingTag(4), panelHeadingTag(1), panelHeadingTag(6)], ["h2", "h3", "h4", "h2", "h2"]);
});

test("Icon: decoration is hidden from assistive tech, a labelled icon is an image", () => {
  assert.deepEqual(iconA11y(undefined), { "aria-hidden": true });
  assert.deepEqual(iconA11y("Unread"), { role: "img", "aria-label": "Unread" });
});

test("Field: one id wires the label, the message line and the control; an error replaces the note and is announced", () => {
  assert.deepEqual(fieldWiring({ id: "plan-days" }), { messageId: null, describedBy: undefined, invalid: undefined, message: null, alert: false });
  assert.deepEqual(fieldWiring({ id: "plan-days", note: "Sessions to replay" }), { messageId: "plan-days-note", describedBy: "plan-days-note", invalid: undefined, message: "Sessions to replay", alert: false });
  assert.deepEqual(fieldWiring({ id: "plan-days", note: "Sessions to replay", error: "Pick 1 to 20" }), { messageId: "plan-days-error", describedBy: "plan-days-error", invalid: true, message: "Pick 1 to 20", alert: true });
  assert.equal(fieldWiring({ id: "x", error: "" }).invalid, undefined, "an empty error is no error");
  assert.deepEqual(fieldWiring({ id: "x", reserve: true }), { messageId: "x-note", describedBy: undefined, invalid: undefined, message: null, alert: false }, "a reserved line exists but says nothing");
});

test("Field: the cue next to the label names what is asked, in one order", () => {
  assert.equal(requirementText({}), null);
  assert.equal(requirementText({ required: true }), "Required");
  assert.equal(requirementText({ optional: true }), "Optional");
  assert.equal(requirementText({ optional: true, hint: "bugs only" }), "Optional · bugs only");
  assert.equal(requirementText({ required: true, hint: "label and URL" }), "Required · label and URL");
  assert.equal(requirementText({ required: true, optional: true }), "Required", "required wins over optional");
});

test("FormActionBar: a dirty form says so unless the screen has something more specific to say", () => {
  assert.equal(UNSAVED_TEXT, "You have unsaved changes");
  assert.equal(formBarStatus({ dirty: true }), UNSAVED_TEXT);
  assert.equal(formBarStatus({ dirty: false }), null);
  assert.equal(formBarStatus({}), null);
  assert.equal(formBarStatus({ dirty: true, status: "Saving…" }), "Saving…");
  assert.equal(formBarStatus({ dirty: false, status: "Sent" }), "Sent");
});

test("unsaved guard: leaving the page is interrupted, in the way every browser asks for", () => {
  let prevented = 0;
  const event: { preventDefault(): void; returnValue?: unknown } = { preventDefault: () => { prevented += 1; } };
  warnBeforeUnload(event);
  assert.equal(prevented, 1);
  assert.equal(event.returnValue, "");
});

test("Segmented and Tabs: the arrows move one step and wrap, Home and End jump, a disabled step is skipped", () => {
  assert.equal(rovingTarget("ArrowRight", 0, 3), 1);
  assert.equal(rovingTarget("ArrowRight", 2, 3), 0, "wraps forward");
  assert.equal(rovingTarget("ArrowLeft", 0, 3), 2, "wraps back");
  assert.equal(rovingTarget("ArrowDown", 0, 3), 1, "a radio group also takes Down");
  assert.equal(rovingTarget("ArrowUp", 0, 3), 2);
  assert.equal(rovingTarget("ArrowDown", 0, 3, { axis: "horizontal" }), null, "tabs leave Up and Down to the page");
  assert.equal(rovingTarget("Home", 2, 4), 0);
  assert.equal(rovingTarget("End", 0, 4), 3);
  assert.equal(rovingTarget("a", 0, 3), null, "a letter is not a move");
  assert.equal(rovingTarget("ArrowRight", 0, 0), null, "an empty group has nowhere to go");
  const enabled = [true, false, true, false];
  assert.equal(rovingTarget("ArrowRight", 0, 4, { enabled }), 2, "skips the disabled step");
  assert.equal(rovingTarget("ArrowRight", 2, 4, { enabled }), 0, "and wraps past the disabled end");
  assert.equal(rovingTarget("End", 0, 4, { enabled }), 2, "End lands on the last step that can take focus");
  assert.equal(rovingTarget("Home", 2, 4, { enabled: [false, true, true, true] }), 1);
  assert.equal(rovingTarget("ArrowRight", 0, 2, { enabled: [false, false] }), null, "nothing can take focus");
});

test("Segmented and Tabs: Tab enters the group once, on the selected step, else the first that is enabled", () => {
  assert.equal(rovingStop(1, [true, true, true]), 1);
  assert.equal(rovingStop(-1, [true, true]), 0, "nothing selected: the first");
  assert.equal(rovingStop(0, [false, true, true]), 1, "the selected step is disabled: the first enabled");
  assert.equal(rovingStop(5, [true, true]), 0, "a stale selection falls back to the first");
});

test("Tabs: a tab names its panel and the panel names its tab", () => {
  assert.deepEqual(tabDomIds("alerts", "active"), { tab: "alerts-tab-active", panel: "alerts-panel-active" });
});

test("a control that opens a mode says Done while the mode is open, instead of looking pressed", () => {
  assert.equal(modeLabel("Manage", false), "Manage");
  assert.equal(modeLabel("Manage", true), "Done");
});

test("RailList: a row with an href is a link, with onSelect a button, with neither plain text; the selection is marked the way the element allows", () => {
  assert.equal(railRowKind({ href: "/a" }), "link");
  assert.equal(railRowKind({ onSelect: () => {} }), "button");
  assert.equal(railRowKind({}), "text", "no hover, no pointer: it does not look clickable");
  assert.equal(railRowKind({ href: "/a", onSelect: () => {} }), "link", "an href wins");
  assert.deepEqual(railRowSelection("link", true), { "aria-current": "page" });
  assert.deepEqual(railRowSelection("link", false), { "aria-current": undefined });
  assert.deepEqual(railRowSelection("button", true), { "aria-pressed": true });
  assert.deepEqual(railRowSelection("button", false), { "aria-pressed": false });
  assert.deepEqual(railRowSelection("text", true), {}, "a plain row is never marked");
});

test("FactList: one column unless two are asked for", () => {
  assert.equal(factColumns(undefined), 1);
  assert.equal(factColumns(1), 1);
  assert.equal(factColumns(2), 2);
  assert.equal(factColumns(3), 1, "anything else is one");
});

test("QueryBoundary: the retry says Trying again only while a retry runs", () => {
  assert.equal(retryLabel(false), "Try again");
  assert.equal(retryLabel(true), "Trying again");
});

test("QueryBoundary: data wins, a retry keeps the error block up, the rest is loading or error", () => {
  const first = { data: null, error: null, loading: true };
  assert.equal(queryView(first), "loading");
  assert.equal(queryView({ data: null, error: new Error("x"), loading: false }), "error");
  assert.equal(queryView({ data: null, error: null, loading: true }, { retrying: true }), "retrying", "the retry started: error cleared, loading true");
  assert.equal(queryView({ data: null, error: new Error("again"), loading: false }, { retrying: true }), "error", "the retry failed: Try again is back");
  assert.equal(queryView({ data: [1], error: new Error("refresh failed"), loading: false }), "ready", "a failed refresh keeps the old values");
  assert.equal(queryView({ data: [], error: null, loading: false }, { isEmpty: true }), "empty");
  assert.equal(queryView({ data: [1], error: null, loading: false }, { isEmpty: false }), "ready");
  assert.equal(queryView({ data: null, error: null, loading: false }), "loading", "a query that is switched off waits");
});
