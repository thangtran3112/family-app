import type { QuietHours as QuietRange } from "@/lib/settings/schema";
import styles from "./settingsDesktop.module.css";

/** Overnight hold window for channel messages (02m §a3.9 `quiet_hours`). Validation is the parent's `QuietHoursSchema`. */
export function QuietHours({ value, disabled, validationError, onChange }: Readonly<{
  value: QuietRange;
  disabled: boolean;
  validationError: boolean;
  onChange: (boundary: keyof QuietRange, value: string) => void;
}>) {
  const describedBy = validationError ? "quiet-hours-error" : "quiet-hours-note";
  return (
    <div className={styles.block}>
      <h3 className={styles.rowTitle}>Quiet hours</h3>
      <p className={styles.helper}>Alerts are held overnight and sent when quiet hours end. Risk alerts still arrive.</p>
      <p className={styles.note} id="quiet-hours-note">Times save as 24-hour HH:MM in America/New_York, including daylight-saving changes. Equal start and end means no quiet period.</p>
      <div className={styles.timeFields}>
        <label className={styles.timeField}>
          <span>Quiet hours start</span>
          <input
            className={styles.input}
            type="time"
            step={60}
            required
            disabled={disabled}
            aria-describedby={describedBy}
            value={value.start}
            onChange={(event) => onChange("start", event.currentTarget.value)}
          />
        </label>
        <label className={styles.timeField}>
          <span>Quiet hours end</span>
          <input
            className={styles.input}
            type="time"
            step={60}
            required
            disabled={disabled}
            aria-describedby={describedBy}
            value={value.end}
            onChange={(event) => onChange("end", event.currentTarget.value)}
          />
        </label>
      </div>
      {validationError && (
        <p className={styles.fieldError} id="quiet-hours-error" role="alert">Enter both quiet-hour times in 24-hour HH:MM format.</p>
      )}
    </div>
  );
}
