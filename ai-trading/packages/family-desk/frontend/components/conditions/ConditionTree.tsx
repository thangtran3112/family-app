"use client";

import type { Condition } from "@ai-trading/contracts";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Field, FieldError, FieldGroup, FieldRow, Select } from "@/components/ui/Field";
import type { Problem } from "@/lib/api/schemas";
import {
  addChild,
  canAddChild,
  canRemoveChild,
  changeKind,
  conditionKind,
  nestingLeft,
  newCondition,
  nodePath,
  removeChild,
  replaceChild,
  type ConditionKind,
} from "@/lib/desk/conditionTree";
import { STRATEGY_OPERAND_CATALOG, type OperandDef } from "@/lib/desk/operands";
import { fieldError } from "@/lib/desk/problems";
import { optionLabel } from "@/lib/spec/labels";
import { ConditionLeaf } from "./ConditionLeaf";
import { PatternFields, type PatternCondition } from "./PatternFields";
import { TimeWindowFields, type TimeWindowCondition } from "./TimeWindowFields";
import styles from "./conditions.module.css";

// The recursive condition editor (design-conditions.md §2): the contract's `Condition` tree, node by node. Every node shows its
// type first, then its own controls (a comparison row, two times, the pattern fields), then its children. One `fieldset` holds
// it all, so a read-only version disables every control natively.

const KINDS: readonly ConditionKind[] = ["compare", "time_between", "pattern", "all", "any", "not"];
const NESTING_KINDS: readonly ConditionKind[] = ["all", "any", "not"];
type Group = Extract<Condition, { all: Condition[] }> | Extract<Condition, { any: Condition[] }>;

const isGroup = (condition: Condition): condition is Group => "all" in condition || "any" in condition;
const groupKey = (condition: Group): "all" | "any" => ("all" in condition ? "all" : "any");
const childrenOf = (condition: Group): Condition[] => ("all" in condition ? condition.all : condition.any);
const idBase = (position: string) => position.replaceAll(".", "-");

/** A node's own problems: a group only the list's own (too small/big), a `not` only itself, a leaf everything below it. */
function nodeProblems(problems: readonly Problem[], path: string, kind: ConditionKind, key?: "all" | "any"): Problem[] {
  if (kind === "all" || kind === "any") return problems.filter((problem) => problem.path === path || (key !== undefined && problem.path === `${path}.${key}`));
  if (kind === "not") return problems.filter((problem) => problem.path === path);
  return problems.filter((problem) => problem.path === path || problem.path.startsWith(`${path}.`));
}

type FocusTarget = { target: "add" | "node"; position: string };

function TreeNode({ condition, path, position, isRoot, defs, problems, disabled, depth, onChange, onFocus }: {
  condition: Condition;
  path: string;
  position: string;
  isRoot: boolean;
  defs: readonly OperandDef[];
  problems: readonly Problem[];
  disabled: boolean;
  depth: number;
  onChange: (next: Condition) => void;
  onFocus: (focus: FocusTarget) => void;
}) {
  const kind = conditionKind(condition);
  const group = isGroup(condition);
  const key = group ? groupKey(condition) : undefined;
  // A comparison row shows its own problems inside ConditionLeaf; every other node shows them under its controls.
  const nodeError = kind === "compare" ? null : fieldError(nodeProblems(problems, path, kind, key));
  const canNest = nestingLeft(depth) > 0;

  return (
    <div className={styles.node} role="group" aria-label={`Condition ${position}`}>
      <Field id={`${idBase(position)}-condition-type`} label="Condition type">
        <Select disabled={disabled} value={kind} onChange={(event) => onChange(changeKind(condition, event.target.value as ConditionKind))}>
          {KINDS.map((item) => (
            <option key={item} value={item} disabled={!canNest && NESTING_KINDS.includes(item)}>{optionLabel(item)}</option>
          ))}
        </Select>
      </Field>
      {kind === "compare" && "left" in condition && "right" in condition && (
        <ConditionLeaf condition={condition} path={path} defs={defs} problems={problems} disabled={disabled} scope onChange={onChange} />
      )}
      {kind === "time_between" && (
        <FieldRow className={styles.controls}>
          <TimeWindowFields condition={condition as TimeWindowCondition} idBase={idBase(position)} onChange={onChange} />
        </FieldRow>
      )}
      {kind === "pattern" && (
        <FieldRow className={styles.controls}>
          <PatternFields condition={condition as PatternCondition} idBase={idBase(position)} onChange={onChange} />
        </FieldRow>
      )}
      {nodeError && <FieldError>{nodeError}</FieldError>}
      {kind === "not" && "not" in condition && (
        <ol className={styles.children}>
          <li className={styles.child}>
            <TreeNode
              condition={condition.not}
              path={nodePath(path, "not")}
              position={`${position}.not`}
              isRoot={false}
              defs={defs}
              problems={problems}
              disabled={disabled}
              depth={depth + 1}
              onChange={(next) => onChange({ not: next })}
              onFocus={onFocus}
            />
          </li>
        </ol>
      )}
      {group && (
        <>
          <ol className={styles.children}>
            {childrenOf(condition).map((child, index) => {
              const childPosition = `${position}.${index + 1}`;
              return (
                <li className={styles.child} key={index}>
                  <TreeNode
                    condition={child}
                    path={nodePath(path, key, index)}
                    position={childPosition}
                    isRoot={false}
                    defs={defs}
                    problems={problems}
                    disabled={disabled}
                    depth={depth + 1}
                    onChange={(next) => onChange(replaceChild(condition, index, next))}
                    onFocus={onFocus}
                  />
                  <Button
                    aria-label={`Remove condition ${childPosition}`}
                    disabled={disabled || !canRemoveChild(condition)}
                    onClick={() => {
                      onChange(removeChild(condition, index));
                      onFocus({ target: "add", position });
                    }}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ol>
          <FieldRow className={styles.actions}>
            <Button
              aria-label={`Add condition to ${position}`}
              disabled={disabled || !canAddChild(condition)}
              onClick={() => {
                const index = childrenOf(condition).length;
                onChange(addChild(condition, newCondition("compare")));
                onFocus({ target: "node", position: `${position}.${index + 1}` });
              }}
            >
              Add condition
            </Button>
          </FieldRow>
        </>
      )}
      {!group && kind !== "not" && isRoot && (
        <FieldRow className={styles.actions}>
          <Button
            aria-label={`Add condition to ${position}`}
            disabled={disabled}
            onClick={() => {
              onChange({ all: [condition, newCondition("compare")] });
              onFocus({ target: "node", position: `${position}.2` });
            }}
          >
            Add condition
          </Button>
        </FieldRow>
      )}
    </div>
  );
}

/**
 * The whole condition tree. `value` is the contract's `Condition` at `basePath` (`"when"`), `problems` are the issues keyed by
 * their real spec path. `disabled` goes to the one `fieldset`, so a read-only version disables every control inside.
 * Add puts focus on the new row's first control, Remove on the group's Add button; nothing calls `onChange` on mount.
 */
export function ConditionTree({ value, onChange, problems = [], defs = STRATEGY_OPERAND_CATALOG, basePath = "when", disabled = false, hideLegend = false, legend = "Conditions" }: {
  value: Condition;
  onChange: (next: Condition) => void;
  problems?: readonly Problem[];
  defs?: readonly OperandDef[];
  basePath?: string;
  disabled?: boolean;
  hideLegend?: boolean;
  legend?: string;
}) {
  const focusTarget = useRef<FocusTarget | null>(null);
  useEffect(() => {
    if (!focusTarget.current) return;
    const target = focusTarget.current;
    const selector = target.target === "add"
      ? `[aria-label="Add condition to ${target.position}"]`
      : `[aria-label="Condition ${target.position}"] select, [aria-label="Condition ${target.position}"] input`;
    document.querySelector<HTMLElement>(selector)?.focus();
    focusTarget.current = null;
  }, [value]);
  const rootError = fieldError(problems.filter((problem) => problem.path === basePath));
  return (
    <FieldGroup legend={legend} hideLegend={hideLegend} disabled={disabled} error={rootError} className={styles.tree}>
      <TreeNode
        condition={value}
        path={basePath}
        position="1"
        isRoot
        defs={defs}
        problems={problems}
        disabled={disabled}
        depth={0}
        onChange={onChange}
        onFocus={(target) => { focusTarget.current = target; }}
      />
    </FieldGroup>
  );
}