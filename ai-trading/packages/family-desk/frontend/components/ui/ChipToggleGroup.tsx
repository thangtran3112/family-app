"use client";

import type { ReactNode } from "react";
import { modeLabel } from "@/lib/desk/primitivesView";
import styles from "./ChipToggleGroup.module.css";

export type ChipOption<T extends string> = {
  id: T;
  label: string;
  /** Longer name or the shortcut, shown as the native tooltip. */
  title?: string;
  /** The chip opens a mode (Manage, Edit) rather than filtering: it says "Done" while the mode is open and is not marked pressed. */
  mode?: boolean;
};

/**
 * Chips that switch a view setting on or off: each is a button with `aria-pressed`, and the group is named by `label`. Several chips may
 * be pressed at once (`pressed` lists them); a one-of-many group passes `[value]` and acts on `onToggle`. "Pressed" means the effect
 * applies: a chip that opens a mode (`mode`) says "Done" instead. Use `Segmented` when the options exclude each other and a value is
 * being chosen, and `Tabs` to switch what is shown below.
 */
export function ChipToggleGroup<T extends string>({
  options,
  pressed,
  onToggle,
  label,
  className,
}: {
  options: ReadonlyArray<ChipOption<T>>;
  pressed: ReadonlyArray<T>;
  onToggle: (id: T) => void;
  label: string;
  /** Layout only (grid-area, margin, width); never colour, size or type. */
  className?: string;
}): ReactNode {
  return (
    <div role="group" aria-label={label} className={`${styles.root} ${className ?? ""}`}>
      {options.map((option) => {
        const on = pressed.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            className={styles.item}
            aria-pressed={option.mode ? undefined : on}
            data-open={option.mode && on ? "true" : undefined}
            title={option.title}
            onClick={() => onToggle(option.id)}
          >
            {option.mode ? modeLabel(option.label, on) : option.label}
          </button>
        );
      })}
    </div>
  );
}
