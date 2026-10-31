"use client";

import type { ReactNode } from "react";
import styles from "./hub.module.css";
import modal from "./newplan.module.css";

/** The id of a cell's note line, for a control's `aria-describedby`. */
export const noteId = (id: string): string => `${id}-note`;

/**
 * One cell of the New plan modal's settings grid (D-075): the label above the control, then one note line. The note is the
 * helper, or the error in its place, so an error never moves the cells below it; `reserve` keeps room for a two-line error.
 * A text control is labelled by `htmlFor`; a segmented group (`group`) by the label's id, `${id}-label`.
 */
export function Cell({
  id,
  label,
  group = false,
  note,
  error,
  span = false,
  reserve = false,
  testId,
  aside,
  children,
}: {
  id: string;
  label: string;
  group?: boolean;
  note?: string | null;
  error?: string | null;
  span?: boolean;
  reserve?: boolean;
  testId?: string;
  /** Something that sits at the end of the label line, such as a badge. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const text = error || note;
  return (
    <div className={span ? `${modal.cell} ${modal.span}` : modal.cell}>
      {aside ? (
        <div className={modal.labelRow}>
          {group ? <span id={`${id}-label`} className={modal.label}>{label}</span> : <label htmlFor={id} className={modal.label}>{label}</label>}
          {aside}
        </div>
      ) : group ? (
        <span id={`${id}-label`} className={modal.label}>{label}</span>
      ) : (
        <label htmlFor={id} className={modal.label}>{label}</label>
      )}
      {children}
      {(text || reserve) && (
        <p id={noteId(id)} data-testid={testId} role={error ? "alert" : undefined} data-error={error ? "true" : undefined} className={reserve ? `${modal.note} ${modal.reserve}` : modal.note}>
          {text}
        </p>
      )}
    </div>
  );
}

export type SegmentOption<T extends string> = { value: T; label: string; held?: boolean };

/** A segmented group (aria-pressed buttons) that sizes to its content. A `held` option stays focusable with `aria-disabled` and does nothing. */
export function Segments<T extends string>({
  id,
  value,
  options,
  onChange,
  describedBy,
}: {
  id: string;
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  describedBy?: string;
}) {
  return (
    <div role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy} className={styles.segmented}>
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
