import type { Technicals } from "@/lib/api/schemas";
import { whatChangedText } from "@/lib/desk/summary";
import { biasTone } from "@/lib/desk/workspace";
import styles from "./summary.module.css";

export function WhatChangedLine({ technicals }: { technicals: Pick<Technicals, "bias_history" | "bias_ready"> }) {
  const text = whatChangedText(technicals);
  const change = technicals.bias_history?.last_change_in_window;
  // Only the destination label is coloured; the sentence stays one text run split at that word.
  const at = change ? text.indexOf(` to ${change.to} `) : -1;

  return (
    <p className={styles.whatChanged}>
      <span className={styles.caps}>What changed</span>
      <span>
        {change && at >= 0 ? (
          <>
            {text.slice(0, at + 4)}
            <span className={styles[biasTone(change.to)]}>{change.to}</span>
            {text.slice(at + 4 + change.to.length)}
          </>
        ) : text}
      </span>
    </p>
  );
}
