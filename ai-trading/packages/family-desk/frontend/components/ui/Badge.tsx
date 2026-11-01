import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { countText } from "@/lib/desk/primitivesView";
import styles from "./Badge.module.css";
import type { Tone } from "./tone";

type BadgeProps = Omit<ComponentPropsWithoutRef<"span">, "className" | "children"> & {
  tone?: Tone;
  /** Layout only (position, margin, width); never colour, size or type. */
  className?: string;
} & (
  /** A word, never colour alone: the label is the meaning, the tone repeats it. */
  | { children: ReactNode; count?: undefined; wrap?: boolean }
  /** A filled count ("3", then "9+") for an unread total; the owner names it (aria-label on its button). */
  | { count: number; children?: undefined; wrap?: undefined }
);

/** The one chip: an outlined status word, or a filled count. Replaces every local `.chip` and unread pill. */
export function Badge({ tone = "neutral", count, wrap, className, children, ...rest }: BadgeProps) {
  return (
    <span className={`${styles.root} ${className ?? ""}`} data-tone={tone} data-kind={count === undefined ? undefined : "count"} data-wrap={wrap ? "true" : undefined} {...rest}>
      {count === undefined ? children : countText(count)}
    </span>
  );
}
