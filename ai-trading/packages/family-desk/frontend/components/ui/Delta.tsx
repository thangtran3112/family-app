import type { ReactNode } from "react";
import type { MetricFormat } from "@/lib/desk/format";
import { deltaView } from "@/lib/desk/primitivesView";
import styles from "./Delta.module.css";
import type { Tone } from "./tone";

type DeltaProps = {
  /** `value` is formatted (signed percent by default); `children` is text a view model already formatted. */
  value?: number | null;
  format?: MetricFormat;
  /** Defaults to the sign of `value`: up, down, or neutral for zero and missing. */
  tone?: Tone;
  children?: ReactNode;
  className?: string;
};

/** A signed change. The sign in the text is the meaning; the colour only repeats it. Tabular figures, size from its parent. */
export function Delta({ value, format, tone, children, className }: DeltaProps) {
  const view = deltaView(value, format, tone);
  return <span className={`${styles.root} ${className ?? ""}`} data-tone={view.tone}>{children ?? view.text}</span>;
}
