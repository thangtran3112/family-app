import { PracticeMarkV1Schema, type PracticeMarkV1 } from "@ai-trading/contracts/replay-session-v1";
import type { EntryOrExit } from "./keys.ts";

// Builds the `PracticeMarkV1` a button or key sends, checked against the contract's own Zod schema first so a bad
// shares or stop field reads as a plain sentence next to the field instead of a round trip (02o §c4).

export type MarkDraft = { shares?: string; stopPrice?: string; note?: string };
export type MarkBuild = { ok: true; mark: PracticeMarkV1 } | { ok: false; message: string };

const parse = (mark: unknown, fieldMessages: Record<string, string>): MarkBuild => {
  const result = PracticeMarkV1Schema.safeParse(mark);
  if (result.success) return { ok: true, mark: result.data };
  const key = result.error.issues[0]?.path[0];
  return { ok: false, message: (typeof key === "string" && fieldMessages[key]) || "That mark isn't valid · check the fields" };
};

const MESSAGES = {
  shares: "Quantity: a whole number of 1 or more",
  stopPrice: "Stop price: a number above 0",
  note: "Note: 1 to 280 plain characters",
};

/** Plain decimals only: `Number()` would also take "0x10", "1e2" and "Infinity". */
export const DECIMAL = /^(\d+\.?\d*|\.\d+)$/;
const number = (text: string | undefined): number | undefined => (text === undefined || text.trim() === "" ? undefined : DECIMAL.test(text.trim()) ? Number(text.trim()) : Number.NaN);
const text = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value.trim());

/** The `shares` column is a 32-bit integer: a bigger quantity gets a sentence that names the top, not "1 or more". */
export const SHARES_MAX = 2_147_483_647;
export const SHARES_TOO_BIG = "Quantity: a whole number from 1 to 2,147,483,647";

export function entryMark(kind: "long_entry" | "short_entry", draft: MarkDraft): MarkBuild {
  const body: Record<string, unknown> = { schemaVersion: 1, kind };
  const shares = number(draft.shares);
  if (shares !== undefined && shares > SHARES_MAX) return { ok: false, message: SHARES_TOO_BIG };
  const stopPrice = number(draft.stopPrice);
  const note = text(draft.note);
  if (shares !== undefined) body.shares = shares;
  if (stopPrice !== undefined) body.stopPrice = stopPrice;
  if (note !== undefined) body.note = note;
  return parse(body, MESSAGES);
}

export function exitMark(kind: "long_exit" | "short_exit", draft: Pick<MarkDraft, "note"> = {}): MarkBuild {
  const note = text(draft.note);
  return parse({ schemaVersion: 1, kind, ...(note !== undefined ? { note } : {}) }, MESSAGES);
}

export const stopMark = (stopPrice: string): MarkBuild => parse({ schemaVersion: 1, kind: "stop", stopPrice: number(stopPrice) }, MESSAGES);
export const noteMark = (note: string): MarkBuild => parse({ schemaVersion: 1, kind: "note", note: text(note) }, MESSAGES);

/** A key or button action to its mark; entries read the shares and stop fields, exits send nothing extra. */
export function markForAction(kind: EntryOrExit, draft: MarkDraft): MarkBuild {
  return kind === "long_entry" || kind === "short_entry" ? entryMark(kind, draft) : exitMark(kind);
}
