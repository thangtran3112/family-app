import { SPEEDS, speedForDigit, type Speed } from "./clock.ts";
import { PRACTICE_COPY } from "../desk/freshness.ts";

// Keyboard map of the replay workspace (02o §a3). Pure: a key press plus the open-trade state in, an action out.

export type OpenSide = "flat" | "long" | "short";
export type EntryOrExit = "long_entry" | "short_entry" | "long_exit" | "short_exit";

export type ReplayAction =
  | { type: "toggle_play" }
  | { type: "step" }
  | { type: "next_signal" }
  | { type: "speed"; speed: Speed }
  | { type: "mark"; kind: EntryOrExit }
  | { type: "stop_note" }
  | { type: "note" }
  | { type: "undo" }
  | { type: "help" }
  | { type: "close" }
  /** F: the chart fills the window (a view state, no navigation). */
  | { type: "toggle_full" }
  /** C: open or close the Chart settings popover. */
  | { type: "chart_settings" }
  /** A key that is valid but not possible now: show the message, send nothing. */
  | { type: "blocked"; message: string };

export type KeyTarget = { tagName?: string; isContentEditable?: boolean; type?: string; role?: string | null } | null;
export type KeyInput = {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: KeyTarget;
};

const TEXT_INPUT_TYPES = new Set(["text", "number", "search", "time", "date", "email", "url", "tel", "password"]);

/** Text fields keep every key for typing. */
export function isTextField(target: KeyTarget | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return true;
  return tag === "INPUT" && TEXT_INPUT_TYPES.has((target.type ?? "text").toLowerCase());
}

/** Buttons, links and tabs use Space themselves, so Space on them is left to the browser. */
export function isActivatable(target: KeyTarget | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "BUTTON" || tag === "A" || tag === "SUMMARY" || target.role === "button" || target.role === "tab" || target.role === "menuitem";
}

/** What B, S or X (key or button) does for the current book: an entry, an exit, or a message why not. */
export function markActionFor(letter: "b" | "s" | "x", side: OpenSide): ReplayAction {
  if (side === "flat") {
    if (letter === "b") return { type: "mark", kind: "long_entry" };
    if (letter === "s") return { type: "mark", kind: "short_entry" };
    return { type: "blocked", message: PRACTICE_COPY.noOpenTrade };
  }
  // Open trade: X always exits; the opposite-side key exits too; the same-side key would be a second entry.
  const exit: EntryOrExit = side === "long" ? "long_exit" : "short_exit";
  if (letter === "x") return { type: "mark", kind: exit };
  const opposite = side === "long" ? "s" : "b";
  return letter === opposite ? { type: "mark", kind: exit } : { type: "blocked", message: PRACTICE_COPY.tradeAlreadyOpen };
}

/**
 * `overlayOpen`: the shortcuts overlay is showing, so only `?` and Escape count.
 * Returns null for a key the workspace ignores (including every browser shortcut).
 */
export function actionForKey(input: KeyInput, side: OpenSide, overlayOpen = false): ReplayAction | null {
  if (isTextField(input.target)) return null;
  if (input.altKey) return null;
  const key = input.key;

  if (input.metaKey || input.ctrlKey) {
    return key.toLowerCase() === "z" && !input.shiftKey && !overlayOpen ? { type: "undo" } : null;
  }
  if (key === "Escape") return { type: "close" };
  if (key === "?") return { type: "help" };
  if (overlayOpen) return null;

  if (key === " ") return isActivatable(input.target) ? null : { type: "toggle_play" };
  if (key === "ArrowRight") return input.shiftKey ? { type: "next_signal" } : { type: "step" };
  if (key.length === 1 && key >= "1" && key <= String(SPEEDS.length)) {
    const speed = speedForDigit(key);
    return speed ? { type: "speed", speed } : null;
  }
  const lower = key.toLowerCase();
  if (input.shiftKey) return null;
  if (lower === "b" || lower === "s" || lower === "x") return markActionFor(lower, side);
  if (lower === "t") return side === "flat" ? { type: "blocked", message: PRACTICE_COPY.stopNeedsTrade } : { type: "stop_note" };
  if (lower === "n") return { type: "note" };
  if (lower === "f") return { type: "toggle_full" };
  if (lower === "c") return { type: "chart_settings" };
  return null;
}

export type OpenLayers = { settings: boolean; help: boolean; composer: boolean; full: boolean };

/** What Escape closes: the innermost layer first, so the settings popover goes before the shortcuts, the composer, then full screen. */
export function layerToClose(open: OpenLayers): keyof OpenLayers | null {
  if (open.settings) return "settings";
  if (open.help) return "help";
  if (open.composer) return "composer";
  return open.full ? "full" : null;
}

/** Rows of the `?` overlay, grouped (the Mercury overlay pattern). */
export const SHORTCUT_GROUPS: ReadonlyArray<{ title: string; rows: ReadonlyArray<{ keys: readonly string[]; label: string }> }> = [
  {
    title: "Playback",
    rows: [
      { keys: ["Space"], label: "Play or pause" },
      { keys: ["→"], label: "Step one bar" },
      { keys: ["Shift", "→"], label: "Jump to the next signal" },
      { keys: ["1", "2", "3", "4"], label: "Speed 1x · 2x · 5x · 10x" },
    ],
  },
  {
    title: "Practice marks",
    rows: [
      { keys: ["B"], label: "Practice long (or exit a short)" },
      { keys: ["S"], label: "Practice short (or exit a long)" },
      { keys: ["X"], label: "Exit the open practice trade" },
      { keys: ["T"], label: "Stop note" },
      { keys: ["N"], label: "Note" },
      { keys: ["⌘", "Z"], label: "Undo the last mark (before the playhead moves)" },
    ],
  },
  {
    title: "View",
    rows: [
      { keys: ["F"], label: "Full screen on or off" },
      { keys: ["C"], label: "Chart settings" },
      { keys: ["Esc"], label: "Close the top layer, then leave full screen" },
    ],
  },
  { title: "Help", rows: [{ keys: ["?"], label: "Show or hide this list" }, { keys: ["Esc"], label: "Close" }] },
];

/** The one-line key legend under the timeline (D-026), a short form of the `?` overlay. */
export const KEY_LEGEND: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: "Space", label: "Play / Pause" },
  { keys: "B", label: "Long" },
  { keys: "S", label: "Short" },
  { keys: "X", label: "Exit" },
  { keys: "T", label: "Stop" },
  { keys: "N", label: "Note" },
  { keys: "⌘Z", label: "undo" },
  { keys: "?", label: "all shortcuts" },
];
