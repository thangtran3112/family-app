import { PATTERN_IDS, type Condition } from "@ai-trading/contracts";
import type { CompareOperator } from "../spec/labels.ts";
import { operandFor } from "./operands.ts";

// The condition tree model (condition kit, design-conditions.md §2-3): pure functions over the contract's `Condition`, no React.
// The editor never invents a node type. Every function returns a new tree and never mutates its input.
export type ConditionKind = "compare" | "time_between" | "pattern" | "all" | "any" | "not";
type Group = Extract<Condition, { all: unknown }> | Extract<Condition, { any: unknown }>;

/** The contract's width cap for one group (`all` and `any` hold 1 to 20 conditions). */
export const MAX_CHILDREN = 20;
/** The UI cap on group-or-`not` nodes on one path from the root. It only stops *adding* nesting; a deeper stored tree renders and edits in full. */
export const MAX_NESTING = 4;

const isGroup = (condition: Condition): condition is Group => "all" in condition || "any" in condition;
const childrenOf = (group: Group): Condition[] => ("all" in group ? group.all : group.any);
const withChildren = (group: Group, children: Condition[]): Group => ("all" in group ? { all: children } : { any: children });

/** `within_pct` is an operator of a comparison, not a kind. */
export function conditionKind(condition: Condition): ConditionKind {
  if ("all" in condition) return "all";
  if ("any" in condition) return "any";
  if ("not" in condition) return "not";
  if (condition.op === "time_between") return "time_between";
  return condition.op === "pattern" ? "pattern" : "compare";
}

/** A new node of `kind`; a group or `not` starts with one comparison inside. */
export function newCondition(kind: ConditionKind): Condition {
  const comparison: Condition = { op: "gte", left: { series: "close" }, right: { value: 0 } };
  if (kind === "time_between") return { op: "time_between", start: "09:30", end: "16:00" };
  if (kind === "pattern") return { op: "pattern", pattern: "hammer" };
  if (kind === "all") return { all: [comparison] };
  if (kind === "any") return { any: [comparison] };
  if (kind === "not") return { not: comparison };
  return comparison;
}

/** Switch a node to another kind, keeping what carries over: children across `all` and `any`, the first child when a group becomes a leaf. */
export function changeKind(current: Condition, kind: ConditionKind): Condition {
  if (conditionKind(current) === kind) return current;
  if (kind === "not") return { not: current };
  if (kind === "all" || kind === "any") {
    const children = isGroup(current) ? childrenOf(current) : [current];
    return kind === "all" ? { all: children } : { any: children };
  }
  if ("not" in current) return changeKind(current.not, kind);
  if (isGroup(current)) return changeKind(childrenOf(current)[0]!, kind);
  return newCondition(kind);
}

/** The one operator switch for a comparison row. Keeps both operands; `within_pct` keeps its `pct` or starts at 1; `pattern` leaves the comparison. */
export function withOperator(condition: Condition, op: CompareOperator | "pattern"): Condition {
  if (op === "pattern") return { op: "pattern", pattern: "hammer" };
  const left = "left" in condition ? condition.left : { series: "close" as const };
  const right = "right" in condition ? condition.right : operandFor({ id: "value", value: 0 });
  if (op === "within_pct") return { op, left, right, pct: "pct" in condition ? condition.pct : 1 };
  return { op, left, right };
}

/** The candlestick patterns a pattern node offers, worded once: "Inverted hammer". */
export const PATTERN_OPTIONS = PATTERN_IDS.map((id) => ({ id, label: id.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase()) }));

/** The dotted path the contract's issues use: `nodePath("when", "all", 1)` is `when.all.1`, `nodePath("when.all.1", "not")` is `when.all.1.not`. */
export function nodePath(parent: string, key?: "all" | "any" | "not", index?: number): string {
  if (key === undefined) return parent;
  return key === "not" ? `${parent}.not` : `${parent}.${key}.${index}`;
}

/** How many more group-or-`not` levels fit below a node that has `depth` of them above it. Never negative, so a deeper stored tree reads as full. */
export const nestingLeft = (depth: number): number => Math.max(0, MAX_NESTING - depth);

export const canAddChild = (condition: Condition): boolean => isGroup(condition) && childrenOf(condition).length < MAX_CHILDREN;
export const canRemoveChild = (condition: Condition): boolean => isGroup(condition) && childrenOf(condition).length > 1;

/** Appends a child (a comparison by default). A full group comes back as it is. */
export function addChild(group: Group, child: Condition = newCondition("compare")): Group {
  return canAddChild(group) ? withChildren(group, [...childrenOf(group), child]) : group;
}

/** Drops one child. The last child stays, because the contract rejects an empty group. */
export function removeChild(group: Group, index: number): Group {
  return canRemoveChild(group) ? withChildren(group, childrenOf(group).filter((_, position) => position !== index)) : group;
}

export const replaceChild = (group: Group, index: number, child: Condition): Group =>
  withChildren(group, childrenOf(group).map((existing, position) => (position === index ? child : existing)));
