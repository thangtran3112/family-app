import assert from "node:assert/strict";
import test from "node:test";
import { SettingsChannelsSchema } from "../api/schemas.ts";
import { loadDeskFixture } from "../fixtures/desk-mvp/load.ts";
import { channelRow, channelRows, hasExternalChannel, NO_CHANNEL_NOTE, testResultText, validateChatId } from "./channelView.ts";

const channels = SettingsChannelsSchema.parse(loadDeskFixture("settings_channels"));

test("inbox is always on; telegram and slack read connected, not connected or not set up", () => {
  const rows = channelRows(channels);
  assert.deepEqual(rows.map((r) => r.channel), ["inbox", "telegram", "slack"]);
  assert.equal(rows[0]!.status, "always_on");
  assert.equal(rows[0]!.statusText, "Always on");
  assert.deepEqual([rows[1]!.status, rows[1]!.canLink, rows[1]!.canTest], ["not_set_up", false, false], "the fixture's keys are not stored yet");
  assert.deepEqual([rows[2]!.status, rows[2]!.canLink, rows[2]!.canTest], ["not_set_up", false, false]);
  const ready = channelRow({ channel: "telegram", connected: false, configured: true, locked: false });
  assert.deepEqual([ready.status, ready.canLink, ready.canTest], ["not_connected", true, false]);
  assert.match(ready.note, /chat ID/);
  const connected = channelRow({ channel: "telegram", connected: true, configured: true, locked: false });
  assert.deepEqual([connected.status, connected.statusText, connected.canTest, connected.canLink], ["connected", "Connected", true, true]);
  assert.equal(channelRow({ channel: "slack", connected: false, configured: true, locked: false }).status, "not_connected");
});

test("no external channel connected is the D10 warning state", () => {
  assert.equal(hasExternalChannel(channels), false);
  assert.equal(hasExternalChannel([...channels, { channel: "slack", connected: true, configured: true, locked: false }]), true);
  assert.match(NO_CHANNEL_NOTE, /inbox only/);
});

test("chat id and test result wording", () => {
  assert.equal(validateChatId(""), "Enter your Telegram chat ID");
  assert.equal(validateChatId("12"), "Chat ID is a number, for example 123456789");
  assert.equal(validateChatId("abc"), "Chat ID is a number, for example 123456789");
  assert.equal(validateChatId("-1001234567890"), null);
  assert.equal(validateChatId(" 123456789 "), null);
  assert.equal(testResultText("sent"), "Test message sent");
  assert.equal(testResultText("not_connected"), "Not connected yet · nothing was sent");
  assert.equal(testResultText("failed"), "Couldn't send the test · Try again");
  assert.equal(testResultText("error"), "Couldn't send the test · Try again");
});
