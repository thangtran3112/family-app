import type { ReactNode } from "react";
import { factColumns } from "@/lib/desk/primitivesView";
import styles from "./FactList.module.css";
import type { Tone } from "./tone";

export type Fact = {
  id: string;
  label: ReactNode;
  value: ReactNode;
  /** Colours the value. The text carries the meaning; the colour only repeats it. */
  tone?: Tone;
};

/**
 * Labels and their values, as a `<dl>`: the label muted on the left, the value on the right and never clipped. One column by default;
 * `columns={2}` sets two pairs side by side in a wide panel. Use `RailList` when the rows are links or buttons, `StatTile` for a figure
 * that stands alone.
 */
export function FactList({
  facts,
  columns,
  divided = false,
  label,
  testId,
  className,
}: {
  facts: ReadonlyArray<Fact>;
  columns?: 1 | 2;
  /** A hairline under each pair. */
  divided?: boolean;
  /** The list's name for assistive tech. */
  label?: string;
  testId?: string;
  /** Layout only (grid-area, margin, width); never colour, size or type. */
  className?: string;
}) {
  return (
    <dl aria-label={label} data-testid={testId} data-columns={factColumns(columns)} data-divided={divided} className={`${styles.list} ${className ?? ""}`}>
      {facts.map((fact) => (
        <div key={fact.id} className={styles.fact}>
          <dt className={styles.label}>{fact.label}</dt>
          <dd className={styles.value} data-tone={fact.tone}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
