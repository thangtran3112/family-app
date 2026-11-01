import Link from "next/link";
import type { ReactNode } from "react";
import { railRowKind, railRowSelection } from "@/lib/desk/primitivesView";
import styles from "./RailList.module.css";
import type { Tone } from "./tone";

export type RailRow = {
  id: string;
  /** The name. One line with an ellipsis (its full text in `title`), so a long name never pushes the value out. */
  label: ReactNode;
  /** Under the label: one muted line (a status, a mode). */
  sub?: ReactNode;
  /** At the end of the row, never clipped. Wrap parts in `RailValue` to give each its tone. */
  value?: ReactNode;
  /** A link row: the whole row is an anchor (a full page navigation, as `Button href`). */
  href?: string;
  /** A button row: the whole row is a button. */
  onSelect?: () => void;
  /** The row the screen is on: a 2 px amber bar on the left, plus `aria-current` (link) or `aria-pressed` (button). */
  selected?: boolean;
  /** Full text for a label that is a node, when it is cut off. */
  title?: string;
};

/** A piece of a row's value in a tone. The text carries the meaning; the colour only repeats it. */
export function RailValue({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span data-tone={tone} className={styles.tone}>{children}</span>;
}

/**
 * Rows of a label and a value in a narrow rail or a side panel. The grid is `minmax(0, 1fr) auto`: the label gives way, the value does not.
 * A row with `href` is a link and a row with `onSelect` is a button, so what looks clickable is; a row with neither is plain text and has
 * no hover. Tables belong in `DenseTable`; label and value pairs with no list semantics belong in `FactList`.
 */
export function RailList({
  rows,
  label,
  size = "sm",
  divided = false,
  client = false,
  testId,
  className,
}: {
  rows: ReadonlyArray<RailRow>;
  /** The list's name for assistive tech. */
  label?: string;
  /** sm 24 px (a panel), md 28 px (a navigation rail). */
  size?: "sm" | "md";
  /** A hairline between rows. */
  divided?: boolean;
  /** Link rows navigate in place with next/link instead of loading the page again. */
  client?: boolean;
  testId?: string;
  /** Layout only (grid-area, margin, padding); never colour, size or type. */
  className?: string;
}) {
  return (
    <ul role="list" aria-label={label} data-testid={testId} data-size={size} data-divided={divided} className={`${styles.list} ${className ?? ""}`}>
      {rows.map((row) => {
        const kind = railRowKind(row);
        const selected = row.selected === true;
        const title = row.title ?? (typeof row.label === "string" ? row.label : undefined);
        const content = (
          <>
            <span className={styles.main}>
              <span className={styles.label} title={title}>{row.label}</span>
              {row.sub !== undefined && <span className={styles.sub}>{row.sub}</span>}
            </span>
            {row.value !== undefined && <span className={styles.value}>{row.value}</span>}
          </>
        );
        const common = { className: styles.row, "data-kind": kind, "data-selected": selected ? "true" : undefined, ...railRowSelection(kind, selected) };
        return (
          <li key={row.id}>
            {kind === "link" ? (
              client ? <Link href={row.href as string} {...common}>{content}</Link> : <a href={row.href} {...common}>{content}</a>
            ) : kind === "button" ? (
              <button type="button" onClick={row.onSelect} {...common}>{content}</button>
            ) : (
              <div {...common}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
