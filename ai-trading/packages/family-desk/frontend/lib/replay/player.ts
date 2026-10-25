import { formatEtTime } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import type { Speed } from "./clock.ts";
import { DEFAULT_SPEED } from "./clock.ts";

// State machine behind `useReplayPlayer` (02o §d): idle (loading) -> paused <-> playing -> at_end, and any
// error drops to paused. `busy` is the one request in flight; nothing issues a second one until it settles.

export type PlayerStatus = "loading" | "paused" | "playing" | "at_end";
export type PlayerState = {
  status: PlayerStatus;
  speed: Speed;
  busy: boolean;
  /** Plain message of the last failed request; cleared by the next success or by playing again. */
  error: string | null;
};

export type PlayerAction =
  | { type: "loaded"; atEnd: boolean }
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "speed"; speed: Speed }
  | { type: "request" }
  | { type: "settled"; atEnd: boolean }
  | { type: "failed"; message: string }
  | { type: "dismiss_error" };

export const initialPlayer = (speed: Speed = DEFAULT_SPEED): PlayerState => ({ status: "loading", speed, busy: false, error: null });

export function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case "loaded":
      return { ...state, status: action.atEnd ? "at_end" : "paused", busy: false, error: null };
    case "play":
      return state.status === "paused" ? { ...state, status: "playing", error: null } : state;
    case "pause":
      return state.status === "playing" ? { ...state, status: "paused" } : state;
    case "toggle":
      return playerReducer(state, { type: state.status === "playing" ? "pause" : "play" });
    case "speed":
      return { ...state, speed: action.speed };
    case "request":
      return { ...state, busy: true };
    case "settled": {
      if (action.atEnd) return { ...state, status: "at_end", busy: false, error: null };
      return { ...state, busy: false, error: null };
    }
    case "failed":
      // Playback never keeps going after an error: the trader reads the message and presses play again.
      return { ...state, status: state.status === "loading" ? "loading" : "paused", busy: false, error: action.message };
    case "dismiss_error":
      return { ...state, error: null };
  }
}

/** A new request may start only when none is in flight and the session has a playhead to move. */
export const canRequest = (state: PlayerState): boolean => !state.busy && state.status !== "loading" && state.status !== "at_end";

/** The line beside the transport buttons: ready, playing, paused or at the window end. */
export function statusLine(status: PlayerStatus, speed: Speed, revealedThrough: string, windowStart: string): string {
  const time = formatEtTime(revealedThrough);
  if (status === "playing") return practiceText("playing", { speed });
  if (status === "at_end") return `Window end · ${time}`;
  if (status === "loading") return PRACTICE_COPY.loadingReplay;
  return Date.parse(revealedThrough) === Date.parse(windowStart) ? practiceText("ready", { time }) : practiceText("paused", { time });
}

/** The pill beside the header readouts (P2): "Playing · 5x", "Paused", "Window end". */
export function playerPillText(status: PlayerStatus, speed: Speed): string {
  switch (status) {
    case "playing": return `Playing · ${speed}x`;
    case "at_end": return "Window end";
    case "loading": return "Loading";
    case "paused": return "Paused";
  }
}
