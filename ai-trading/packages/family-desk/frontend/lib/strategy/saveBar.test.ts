import assert from "node:assert/strict";
import test from "node:test";
import { saveBarCopy } from "./saveBar.ts";

const idle = { dirty: false, hasVersion: true, valid: true, readOnly: false, stage: "alert_only", nextVersion: 2 } as const;

test("V-Strategies-01: an untouched form does not claim something was just saved", () => {
  const copy = saveBarCopy(idle);
  assert.equal(copy.title, "No changes yet");
  assert.equal(copy.title.includes("Version saved"), false);
  assert.equal(copy.note, "Edit the form to save a new version. Alerts run on the current version until you do.");
});

test("an edited, valid form says saving makes the next version live", () => {
  const copy = saveBarCopy({ ...idle, dirty: true });
  assert.equal(copy.title, "Unsaved changes");
  assert.equal(copy.note, "Saving makes version 2 the one this strategy alerts on.");
  assert.equal(saveBarCopy({ ...idle, dirty: true, stage: "draft" }).note, null);
});

test("V-Strategies-04: a disabled Save explains itself beside the button", () => {
  const copy = saveBarCopy({ ...idle, dirty: true, valid: false });
  assert.equal(copy.title, "Can't save yet");
  assert.equal(copy.note, "Fix the highlighted fields above, then save.");
  assert.equal(saveBarCopy({ ...idle, hasVersion: false, valid: true }).title, "Initial version required");
  assert.equal(saveBarCopy({ ...idle, readOnly: true }).note, "You are viewing an older version. Choose the current version to edit.");
});
