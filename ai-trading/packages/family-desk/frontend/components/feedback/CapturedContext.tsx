"use client";

import { Field, Select } from "@/components/ui/Field";
import { SCREEN_OPTIONS, type Captured } from "@/lib/desk/feedbackContext";
import { formatEtDayTime } from "@/lib/desk/feedbackView";
import { EMPTY_VALUE } from "@/lib/desk/format";
import styles from "./feedbackForm.module.css";

/** "Where were you?" (02s): what the Desk captured when the form opened. Only the screen can be changed, for when the capture is wrong. */
export function CapturedContext({ captured, screen, onScreenChange }: { captured: Captured; screen: string; onScreenChange: (next: string) => void }) {
  // A route outside the list (a screen added later) stays selectable, so the select never shows a name she did not choose.
  const options = SCREEN_OPTIONS.includes(screen) ? SCREEN_OPTIONS : [screen, ...SCREEN_OPTIONS];
  const rows: [string, string][] = [
    ["Screen", screen],
    ["Route", captured.route],
    ["Practice day", captured.dayListId ? `Day list ${captured.dayListId}` : EMPTY_VALUE],
    ["Symbol", captured.symbol ?? EMPTY_VALUE],
    ["App version", captured.appVersion],
    ["Captured", formatEtDayTime(captured.capturedAt)],
  ];
  return (
    <section className={styles.field} aria-labelledby="feedback-where">
      <div className={styles.labelRow}>
        <h2 id="feedback-where" className={styles.label}>Where were you?</h2>
        <span className={styles.hint}>Captured automatically when you opened this form</span>
      </div>
      <div className={styles.panel}>
        <dl className={styles.ctxList}>
          {rows.map(([key, value]) => (
            <div key={key} className={styles.ctxRow}>
              <dt className={styles.ctxKey}>{key}</dt>
              <dd className={styles.ctxValue}>{value}</dd>
            </div>
          ))}
        </dl>
        <Field id="feedback-screen" label="Which screen?" note="Change it if the capture is wrong." className={styles.screenField}>
          <Select value={screen} onChange={(event) => onScreenChange(event.target.value)}>
            {options.map((option) => <option key={option} value={option}>{option}</option>)}
          </Select>
        </Field>
      </div>
    </section>
  );
}
