import type { Problem } from "../../lib/api/schemas.ts";
import { nodePath } from "../../lib/desk/conditionTree.ts";
import { fieldError } from "../../lib/desk/problems.ts";

// How a condition's number boxes (and the lines under their row) find each other. Kept pure so node --test can check it.
// A box is at a spec path (`when.all.1.left.lookbackDays`). Its id is that path and its problem's line carries the Field scheme's
// `${id}-error`, so the box and the line agree without sharing state, and the same box has the same id after a re-render.

/** A row's place in the spec: a single row is the condition itself (`when`), several sit in the group (`when.all.1`). */
export const rowPath = (form: { mode: "all" | "any"; rows: readonly unknown[] }, index: number): string => (form.rows.length === 1 ? "when" : nodePath("when", form.mode, index));

/** The id of the box at a spec path. */
export const boxId = (path: string): string => `condition-${path}`;

/** The id of the line that prints the problem of the box at `path`: `Field`'s own message id for that box. */
export const boxLineId = (path: string): string => `${boxId(path)}-error`;

/** What a `Field` around the box `key` of the operand at `path` needs: its id, and the sentence for its own problems (null with none; the row's line prints it). */
export const boxField = (problems: readonly Problem[], path: string, key: string): { id: string; error: string | null } => {
  const at = `${path}.${key}`;
  return { id: boxId(at), error: fieldError(problems.filter((problem) => problem.path === at)) };
};

/** The problems as one entry per path, in order of first appearance: a box has one line, so two sentences for one path share it. */
export function problemsByPath(problems: readonly Problem[]): { path: string; problems: Problem[] }[] {
  const groups = new Map<string, Problem[]>();
  for (const problem of problems) groups.set(problem.path, [...(groups.get(problem.path) ?? []), problem]);
  return [...groups].map(([path, list]) => ({ path, problems: list }));
}
