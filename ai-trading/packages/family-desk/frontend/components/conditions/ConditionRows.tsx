"use client";

import type { Condition } from "@ai-trading/contracts";
import { Button } from "@/components/ui/Button";
import { ChoiceGroup, FieldGroup, FieldRow, Radio } from "@/components/ui/Field";
import type { Problem } from "@/lib/api/schemas";
import { nodePath } from "@/lib/desk/conditionTree";
import { addRow, removeRow, updateRow, type FilterForm } from "@/lib/desk/filterForm";
import { OPERAND_CATALOG } from "@/lib/desk/operands";
import { fieldError } from "@/lib/desk/problems";
import { ConditionLeaf } from "./ConditionLeaf";
import styles from "./conditions.module.css";

/** A row's place in the spec: a single row is the condition itself (`when`), several sit in the group (`when.all.1`). */
const rowPath = (form: FilterForm, index: number) => (form.rows.length === 1 ? "when" : nodePath("when", form.mode, index));

function ConditionRow({ condition, index, form, onChange, problems }: {
  condition: Condition;
  index: number;
  form: FilterForm;
  onChange: (next: FilterForm) => void;
  problems: readonly Problem[];
}) {
  const remove = (
    <Button aria-label={`Remove condition ${index + 1}`} disabled={form.rows.length === 1} onClick={() => onChange(removeRow(form, index))}>
      Remove
    </Button>
  );
  return (
    <div className={styles.condition}>
      <ConditionLeaf
        condition={condition}
        path={rowPath(form, index)}
        defs={OPERAND_CATALOG}
        problems={problems}
        onChange={(next) => onChange(updateRow(form, index, next))}
        actions={remove}
      />
    </div>
  );
}

export function ConditionRows({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  // Group-level problems (`when` or `when.all`) belong to no single row, so they show under the list.
  const groupError = fieldError(form.rows.length > 1 ? problems.filter((problem) => problem.path === "when" || problem.path === `when.${form.mode}`) : []);
  return (
    <FieldGroup legend="Conditions" error={groupError}>
      {form.rows.length > 1 && (
        <ChoiceGroup label="Match">
          <Radio name="condition-mode" label="All of these" checked={form.mode === "all"} onChange={() => onChange({ ...form, mode: "all" })} />
          <Radio name="condition-mode" label="Any of these" checked={form.mode === "any"} onChange={() => onChange({ ...form, mode: "any" })} />
        </ChoiceGroup>
      )}
      {form.rows.map((condition, index) => (
        <ConditionRow key={index} condition={condition} index={index} form={form} onChange={onChange} problems={problems} />
      ))}
      <FieldRow>
        <Button onClick={() => onChange(addRow(form))}>Add condition</Button>
      </FieldRow>
    </FieldGroup>
  );
}
