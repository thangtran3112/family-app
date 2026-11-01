"use client";

import { useFieldControl } from "@/components/ui/Field";
import styles from "./hub.module.css";

export type SegmentOption<T extends string> = { value: T; label: string; held?: boolean };

/**
 * A segmented group (aria-pressed buttons) that sizes to its content. A `held` option stays focusable with `aria-disabled` and does
 * nothing. Put it in a `<Field group id>`: the label names the group and the field's note or error describes it.
 */
export function Segments<T extends string>({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
}) {
  const field = useFieldControl();
  return (
    <div role="group" aria-labelledby={`${id}-label`} aria-describedby={field?.describedBy} className={styles.segmented}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={styles.segment}
          aria-pressed={option.value === value}
          aria-disabled={option.held ? true : undefined}
          onClick={() => {
            if (!option.held) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
