"use client";

import { useId } from "react";
import { SEVERITIES } from "@/lib/desk/feedbackView";
import type { FeedbackSeverity } from "@/lib/feedback/schemas";
import styles from "./feedbackForm.module.css";

/** P0 to P3 with the `DEFECTS.md` meanings as helper text (02s decision 4): one scale across the agent ledger and this log. */
export function SeverityRadios({ value, onChange }: { value: FeedbackSeverity; onChange: (next: FeedbackSeverity) => void }) {
  const labelId = useId();
  return (
    <div className={styles.field}>
      <div className={styles.labelGroup}>
        <span id={labelId} className={styles.label}>Severity</span>
        <span className={styles.hint}>Bugs only · same scale as the Desk defect ledger</span>
      </div>
      <div role="radiogroup" aria-labelledby={labelId} className={styles.severity}>
        {SEVERITIES.map((severity) => (
          <label key={severity.id} className={styles.sevCard}>
            <span className={styles.sevHead}>
              <input
                type="radio"
                name="feedback-severity"
                className={styles.sevRadio}
                value={severity.id}
                checked={value === severity.id}
                onChange={() => onChange(severity.id)}
              />
              {severity.id}
            </span>
            <span className={styles.sevHelp}>{severity.help}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
