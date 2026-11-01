// What is left of the replay workspace's old key map: Practice has no keyboard shortcuts (owner, 2026-11-01), so these are only the
// shared types (the side of an open trade, the four mark kinds) and `isTextField`, which the shell's mode keys use to leave a field alone.

export type OpenSide = "flat" | "long" | "short";
export type EntryOrExit = "long_entry" | "short_entry" | "long_exit" | "short_exit";

export type KeyTarget = { tagName?: string; isContentEditable?: boolean; type?: string; role?: string | null } | null;

const TEXT_INPUT_TYPES = new Set(["text", "number", "search", "time", "date", "email", "url", "tel", "password"]);

/** Text fields keep every key for typing. */
export function isTextField(target: KeyTarget | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return true;
  return tag === "INPUT" && TEXT_INPUT_TYPES.has((target.type ?? "text").toLowerCase());
}
