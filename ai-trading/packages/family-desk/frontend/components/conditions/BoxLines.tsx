import { FieldError } from "@/components/ui/Field";
import type { Problem } from "@/lib/api/schemas";
import { fieldError } from "@/lib/desk/problems";
import { boxLineId, problemsByPath } from "./conditionBoxes";

/**
 * The problem lines under a condition row or a Rank group: one line per spec path, each under the id its box points at (`aria-describedby`),
 * so the sentence prints once and the box it belongs to is tied to it. `line` words one path's problems (default: their plain sentences).
 */
export function BoxLines({ problems, line = fieldError }: { problems: readonly Problem[]; line?: (problems: readonly Problem[]) => string | null }) {
  return problemsByPath(problems).map(({ path, problems: list }) => <FieldError key={path} id={boxLineId(path)}>{line(list)}</FieldError>);
}
