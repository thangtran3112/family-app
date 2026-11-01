"use client";

import { Fragment, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useFieldControl } from "@/components/ui/Field";
import { rovingStop, rovingTarget } from "@/lib/desk/primitivesView";
import styles from "./Segmented.module.css";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** Why the option cannot be chosen. Setting it disables the option and shows the reason as its `title` and its description. */
  disabledReason?: string;
  /** The id of an element on screen that already says the reason (a field's note): the option is described by it, and no hidden copy of the text is rendered. */
  reasonId?: string;
};

/**
 * One choice out of a few, always visible: a radio group drawn as a row of segments, the selected one on a raised fill. The arrows
 * move the choice (and wrap), Home and End jump, Tab enters and leaves the group once. Inside a `<Field group>` it takes the
 * field's label and message line. Use `Tabs` to switch what is shown below, and `ChipToggleGroup` for filters that can be combined.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  labelledBy,
  size = "lg",
  className,
}: {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  /** The group's name when no visible label points at it. */
  label?: string;
  labelledBy?: string;
  /** md 28 px (a toolbar), lg 32 px (a form). */
  size?: "md" | "lg";
  /** Layout only (grid-area, margin, width); never colour, size or type. */
  className?: string;
}) {
  const field = useFieldControl();
  const base = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((option) => option.disabledReason === undefined);
  const stop = rovingStop(options.findIndex((option) => option.value === value), enabled);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = rovingTarget(event.key, index, options.length, { enabled });
    const option = next === null ? undefined : options[next];
    if (option === undefined) return;
    event.preventDefault();
    buttons.current[next as number]?.focus();
    onChange(option.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy ?? (label === undefined && field?.group ? `${field.id}-label` : undefined)}
      aria-describedby={field?.describedBy}
      className={`${styles.root} ${className ?? ""}`}
      data-size={size}
    >
      {options.map((option, index) => {
        const reasonId = option.reasonId ?? `${base}-${index}-reason`;
        return (
          <Fragment key={option.value}>
          <button
            ref={(element) => { buttons.current[index] = element; }}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            aria-disabled={option.disabledReason === undefined ? undefined : true}
            aria-describedby={option.disabledReason === undefined ? undefined : reasonId}
            title={option.disabledReason}
            tabIndex={index === stop ? 0 : -1}
            className={styles.segment}
            onClick={() => { if (option.disabledReason === undefined) onChange(option.value); }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </button>
          {/* Beside the button, not inside it: a description inside would become part of the button's name. */}
          {option.disabledReason !== undefined && option.reasonId === undefined && <span id={reasonId} className="sr-only">{option.disabledReason}</span>}
          </Fragment>
        );
      })}
    </div>
  );
}
