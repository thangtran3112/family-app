import assert from "node:assert/strict";
import test from "node:test";
import { isTextField } from "./keys.ts";

test("text fields, selects and editable regions keep every key", () => {
  for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "INPUT", type: "number" }, { tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
    assert.equal(isTextField(target), true, target.tagName);
  }
  assert.equal(isTextField({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTextField({ tagName: "INPUT", type: "radio" }), false);
  assert.equal(isTextField({ tagName: "BUTTON" }), false);
  assert.equal(isTextField(null), false);
  assert.equal(isTextField(undefined), false);
});
