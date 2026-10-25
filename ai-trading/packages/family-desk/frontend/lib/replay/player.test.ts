import assert from "node:assert/strict";
import test from "node:test";
import { canRequest, initialPlayer, playerReducer, statusLine, type PlayerAction, type PlayerState } from "./player.ts";

const run = (actions: PlayerAction[], start: PlayerState = initialPlayer()) => actions.reduce(playerReducer, start);

test("idle loads into paused (or at_end), then plays and pauses", () => {
  assert.equal(initialPlayer().status, "loading");
  assert.equal(run([{ type: "loaded", atEnd: false }]).status, "paused");
  assert.equal(run([{ type: "loaded", atEnd: true }]).status, "at_end");
  assert.equal(run([{ type: "loaded", atEnd: false }, { type: "play" }]).status, "playing");
  assert.equal(run([{ type: "loaded", atEnd: false }, { type: "toggle" }, { type: "toggle" }]).status, "paused");
});

test("play is ignored while loading and after the end", () => {
  assert.equal(run([{ type: "play" }]).status, "loading");
  assert.equal(run([{ type: "loaded", atEnd: true }, { type: "play" }]).status, "at_end");
});

test("one request in flight: nothing new starts until it settles", () => {
  const playing = run([{ type: "loaded", atEnd: false }, { type: "play" }]);
  assert.equal(canRequest(playing), true);
  const busy = playerReducer(playing, { type: "request" });
  assert.equal(canRequest(busy), false);
  const done = playerReducer(busy, { type: "settled", atEnd: false });
  assert.equal(canRequest(done), true);
  assert.equal(done.status, "playing");
});

test("reaching the end stops playback and further requests", () => {
  const ended = run([{ type: "loaded", atEnd: false }, { type: "play" }, { type: "request" }, { type: "settled", atEnd: true }]);
  assert.equal(ended.status, "at_end");
  assert.equal(canRequest(ended), false);
});

test("any error drops to paused with the message, and playing again clears it", () => {
  const failed = run([{ type: "loaded", atEnd: false }, { type: "play" }, { type: "request" }, { type: "failed", message: "Couldn't load the next minute · Try again" }]);
  assert.equal(failed.status, "paused");
  assert.equal(failed.busy, false);
  assert.equal(failed.error, "Couldn't load the next minute · Try again");
  const again = playerReducer(failed, { type: "play" });
  assert.equal(again.status, "playing");
  assert.equal(again.error, null);
  assert.equal(run([{ type: "failed", message: "x" }]).status, "loading", "a failed first load stays on the loading screen's error");
});

test("speed changes keep the status", () => {
  const state = run([{ type: "loaded", atEnd: false }, { type: "play" }, { type: "speed", speed: 5 }]);
  assert.equal(state.status, "playing");
  assert.equal(state.speed, 5);
});

test("the status line reads ready at the open, then paused, playing and window end", () => {
  const start = "2026-04-07T13:30:00Z";
  assert.equal(statusLine("paused", 1, start, start), "Paused at 9:30 AM · press Space to play");
  assert.equal(statusLine("paused", 1, "2026-04-07T14:07:12Z", start), "Paused at 10:07 AM");
  assert.equal(statusLine("playing", 5, "2026-04-07T14:07:12Z", start), "Playing at 5x");
  assert.equal(statusLine("at_end", 1, "2026-04-07T20:00:00Z", start), "Window end · 4:00 PM");
  assert.equal(statusLine("loading", 1, start, start), "Preparing the replay…");
});
