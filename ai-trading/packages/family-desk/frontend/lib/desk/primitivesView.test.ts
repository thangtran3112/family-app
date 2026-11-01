import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TONES } from "../../components/ui/tone.ts";
import { signTone } from "./format.ts";
import { bannerRole, buttonState, countText, deltaView, fieldWiring, iconA11y, panelHeadingTag, requirementText, statTileTag } from "./primitivesView.ts";

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
