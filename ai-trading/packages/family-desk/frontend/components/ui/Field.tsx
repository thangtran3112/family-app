"use client";

import { createContext, useContext, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { fieldWiring, requirementText, type FieldWiring } from "@/lib/desk/primitivesView";
import styles from "./Field.module.css";

type Layout = { /** Layout only (grid-area, margin, width); never colour, size or type. */ className?: string };

type Wired = FieldWiring & { id: string; required: boolean; group: boolean };
const FieldContext = createContext<Wired | null>(null);

/** What a control inside a `Field` gets: its id, `aria-describedby`, `aria-invalid` and `aria-required`. Null outside a field. */
export const useFieldControl = (): Wired | null => useContext(FieldContext);

const join = (...names: (string | undefined)[]) => names.filter(Boolean).join(" ");

/**
 * A label, one control and one message line (or, with `group`, a group of controls under one label and one line). `id` is the control's id; the label points at it (or, with `group`, names a
 * group of controls by `${id}-label`). The line under the control is the `note`, or the `error` in its place (announced
 * as an alert), and the control's `aria-describedby` and `aria-invalid` follow it. `Input`, `NumberInput`, `Select` and
 * `Textarea` read that wiring, so a form never repeats an id by hand. Error words come from lib/desk/problems.ts.
 */
export function Field({
  id,
  label,
  group = false,
  required = false,
  optional = false,
  hint,
  note,
  error,
  reserve = false,
  testId,
  aside,
  children,
  className,
}: Layout & {
  id: string;
  label: ReactNode;
  /** The children are a group of controls (radios, a segmented control): the label names the group instead of one control. */
  group?: boolean;
  required?: boolean;
  optional?: boolean;
  /** Short cue beside the label, after "Required" or "Optional". */
  hint?: string;
  note?: string | null;
  error?: string | null;
  /** Keep the message line's room when it is empty, so a note that comes and goes never moves the fields below. */
  reserve?: boolean;
  testId?: string;
  /** At the end of the label line: a counter, a badge. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const wiring = fieldWiring({ id, note, error, reserve });
  const cue = requirementText({ required, optional, hint });
  const name = group ? <span id={`${id}-label`} className={styles.label}>{label}</span> : <label htmlFor={id} className={styles.label}>{label}</label>;
  return (
    <FieldContext.Provider value={{ ...wiring, id, required, group }}>
      <div className={join(styles.field, className)}>
        <div className={styles.labelRow}>
          <div className={styles.labelGroup}>
            {name}
            {cue && <span className={styles.cue}>{cue}</span>}
          </div>
          {aside}
        </div>
        {children}
        {wiring.messageId !== null && (
          <p id={wiring.messageId} data-testid={testId} role={wiring.alert ? "alert" : undefined} data-error={wiring.alert ? "true" : undefined} data-reserve={reserve ? "true" : undefined} className={styles.message}>
            {wiring.message}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

/** A problem line for a set of controls rather than one field (a condition row, a step): announced, in the error tone. */
export function FieldError({ id, children, className }: Layout & { id?: string; children: ReactNode }) {
  return <p id={id} role="alert" data-error="true" className={join(styles.message, className)}>{children}</p>;
}

/** A row of fields (or a field and its buttons) that wraps instead of clipping. */
export function FieldRow({ children, className }: Layout & { children: ReactNode }) {
  return <div className={join(styles.row, className)}>{children}</div>;
}

/** A bordered set of related fields under one caps legend (a `fieldset`). `error` is the line for a problem that belongs to the whole set. */
export function FieldGroup({ legend, hideLegend = false, error, bare = false, children, className, ...rest }: Layout & { legend: ReactNode; /** Name the group for assistive tech only (the section already has a visible heading). */ hideLegend?: boolean; error?: string | null; bare?: boolean; disabled?: boolean; children: ReactNode; "aria-describedby"?: string }) {
  return (
    <fieldset className={join(styles.group, className)} data-bare={bare || hideLegend ? "true" : undefined} {...rest}>
      <legend className={hideLegend ? "sr-only" : undefined}>{legend}</legend>
      {children}
      {error && <FieldError>{error}</FieldError>}
    </fieldset>
  );
}

function controlProps(field: Wired | null, own: { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling"; "aria-required"?: boolean | "true" | "false" }) {
  // A group's controls (a list of link rows) are not the field's one control: the group wiring is for custom group controls only.
  const wired = field?.group ? null : field;
  return {
    id: own.id ?? wired?.id,
    "aria-describedby": own["aria-describedby"] ?? wired?.describedBy,
    "aria-invalid": own["aria-invalid"] ?? wired?.invalid,
    "aria-required": own["aria-required"] ?? (wired?.required ? true : undefined),
  };
}

/** A one-line text control at the Desk's control height. Inside a `Field` it takes the field's id and message wiring. */
export function Input({ className, ...props }: Layout & Omit<ComponentPropsWithoutRef<"input">, "className">) {
  return <input type="text" {...props} {...controlProps(useFieldControl(), props)} className={join(styles.control, className)} />;
}

/** A number control: `min`, `max`, `step` and `inputMode` are the caller's, a `unit` shows after it. Values stay strings so a half-typed number is not lost. */
export function NumberInput({ unit, className, ...props }: Layout & Omit<ComponentPropsWithoutRef<"input">, "className" | "type"> & { unit?: string }) {
  const input = <input type="number" {...props} {...controlProps(useFieldControl(), props)} className={styles.control} />;
  return <span className={join(styles.numberWrap, className)}>{input}{unit && <span className={styles.unit}>{unit}</span>}</span>;
}

export function Select({ className, ...props }: Layout & Omit<ComponentPropsWithoutRef<"select">, "className">) {
  return <select {...props} {...controlProps(useFieldControl(), props)} className={join(styles.control, className)} />;
}

export function Textarea({ className, ...props }: Layout & Omit<ComponentPropsWithoutRef<"textarea">, "className">) {
  return <textarea {...props} {...controlProps(useFieldControl(), props)} className={join(styles.control, className)} />;
}

type ChoiceProps = Layout & Omit<ComponentPropsWithoutRef<"input">, "className" | "type" | "children"> & { label: ReactNode; hint?: ReactNode };

function Choice({ type, label, hint, className, ...input }: ChoiceProps & { type: "checkbox" | "radio" }) {
  return (
    <label className={join(styles.choice, className)} data-disabled={input.disabled ? "true" : undefined}>
      <input type={type} {...input} />
      {label}
      {hint && <span className={styles.choiceHint}>{hint}</span>}
    </label>
  );
}

/** One checkbox with its label (and an optional hint after it). The label wraps the box, so the whole line is the target. */
export const Checkbox = (props: ChoiceProps) => <Choice type="checkbox" {...props} />;

/** One radio with its label. Put the radios of one question in a `ChoiceGroup` and give them one `name`. */
export const Radio = (props: ChoiceProps) => <Choice type="radio" {...props} />;

/** The radios or checkboxes of one question, named for assistive tech. `stack` puts one per line. */
export function ChoiceGroup({ label, stack = false, children, className }: Layout & { label: string; stack?: boolean; children: ReactNode }) {
  return <div role="group" aria-label={label} className={join(styles.choices, className)} data-stack={stack ? "true" : undefined}>{children}</div>;
}

/** A value that is shown, not edited (a locked setting): plain text, never a greyed control (V-SCR-11). */
export function ReadOnlyValue({ children, className }: Layout & { children: ReactNode }) {
  return <p className={join(styles.value, className)}>{children}</p>;
}

/** An on/off setting that applies at once: a checkbox with `role="switch"`. Label it with a `<label htmlFor>` or `aria-label`. */
export function Switch({ className, ...props }: Layout & Omit<ComponentPropsWithoutRef<"input">, "className" | "type" | "role">) {
  return <input type="checkbox" role="switch" {...props} className={join(styles.switch, className)} />;
}
