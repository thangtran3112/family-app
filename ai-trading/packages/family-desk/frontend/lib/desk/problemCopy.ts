import { paramLabel, subLabel } from "../spec/labels.ts";

/** Plain-language copy for server and schema validation problems. A trader sees a field name and an instruction, never a JSON path. */

const NOUNS: Record<string, string> = { "watch.universe.symbols": "symbol", "then.alert.channels": "channel" };
const noun = (path: string) => NOUNS[path] ?? "item";
const group = (text: string, pattern: RegExp) => pattern.exec(text)?.[1];

/** Pydantic (server) and Zod (client) wording for the same mistake maps to one sentence. Anything else is already English and passes through. */
export function plainMessage(message: string, path = ""): string {
  const text = message.trim();
  const items = group(text, /^List should have at least (\d+) items?\b/) ?? group(text, /^Too small: expected array to have >=(\d+) items?/);
  if (items) return `Add at least ${items} ${noun(path)}${items === "1" ? "" : "s"}.`;
  const chars = group(text, /^Too small: expected string to have >=(\d+) characters?/) ?? group(text, /^String should have at least (\d+) characters?/);
  if (chars) return chars === "1" ? "Fill this in." : `Use at least ${chars} characters.`;
  if (text === "Field required") return "Fill this in.";
  const min = group(text, /^Too small: expected number to be >=(-?[\d.]+)/) ?? group(text, /^Input should be greater than or equal to (-?[\d.]+)/);
  if (min) return `Must be ${min} or more.`;
  const over = group(text, /^Too small: expected number to be >(-?[\d.]+)/) ?? group(text, /^Input should be greater than (-?[\d.]+)/);
  if (over) return `Must be more than ${over}.`;
  const max = group(text, /^Too big: expected number to be <=(-?[\d.]+)/) ?? group(text, /^Input should be less than or equal to (-?[\d.]+)/);
  if (max) return `Must be ${max} or less.`;
  const under = group(text, /^Too big: expected number to be <(-?[\d.]+)/) ?? group(text, /^Input should be less than (-?[\d.]+)/);
  if (under) return `Must be less than ${under}.`;
  if (/^Invalid input: expected number, received (NaN|-?Infinity)$/.test(text) || text === "Input should be a valid number") return "Enter a number.";
  if (/^Invalid input: expected int\b/.test(text) || text === "Input should be a valid integer") return "Use a whole number.";
  if (text === "Invalid input") return "Check this value.";
  return text;
}

/** The form control a spec path belongs to: `watch.universe.symbols` is "Symbols", `when.all.1.right` is "Condition 2 · right side". */
export function fieldLabel(path: string): string {
  const parts = path.split(".");
  if (parts[0] === "when") {
    let index: number | null = null;
    const rest: string[] = [];
    for (const part of parts.slice(1)) {
      if (/^\d+$/.test(part)) index = Number(part) + 1; // ponytail: nested groups keep only the innermost number
      else if (!["all", "any", "not"].includes(part)) rest.push(paramLabel(part));
    }
    return ["Condition" + (index === null ? "" : ` ${index}`), ...rest].join(" · ");
  }
  if (parts[0] === "then" && parts[1] === "paperOrder") {
    const rest = parts.slice(2);
    const leaf = rest.at(-1);
    const parent = rest.at(-2);
    const label = leaf === undefined ? null : parent === "stop" || parent === "target" ? subLabel(paramLabel(parent), leaf) : paramLabel(leaf);
    return label === null ? "Paper order" : `Paper order · ${label}`;
  }
  return paramLabel(parts.at(-1) ?? "");
}

export type PlainProblem = { field: string; text: string };
export const plainProblem = (problem: { path: string; message: string }): PlainProblem => ({
  field: fieldLabel(problem.path),
  text: plainMessage(problem.message, problem.path),
});

/** "Symbols: Add at least 1 symbol." */
export function problemLine(problem: { path: string; message: string }): string {
  const { field, text } = plainProblem(problem);
  return `${field}: ${text}`;
}
