import { Field, FieldError, FieldRow, Input } from "@/components/ui/Field";
import type { QuietHours as QuietRange } from "@/lib/settings/schema";
import styles from "./settingsDesktop.module.css";

/** Overnight hold window for channel messages (02m §a3.9 `quiet_hours`). Validation is the parent's `QuietHoursSchema`. */
export function QuietHours({ value, disabled, validationError, onChange, onCommit }: Readonly<{
  value: QuietRange;
  disabled: boolean;
  validationError: boolean;
  onChange: (boundary: keyof QuietRange, value: string) => void;
  /** Called when a time field loses focus: the draft is saved then, not on every keystroke. */
  onCommit: () => void;
}>) {
  // One message line serves both times, so both controls name it themselves.
  const describedBy = validationError ? "quiet-hours-error" : "quiet-hours-note";
  const time = (boundary: keyof QuietRange) => ({
    type: "time" as const,
    step: 60,
    required: true,
    disabled,
    "aria-describedby": describedBy,
    "aria-invalid": validationError || undefined,
    value: value[boundary],
    onChange: (event: { currentTarget: { value: string } }) => onChange(boundary, event.currentTarget.value),
    onBlur: onCommit,
  });
  return (
    <div className={styles.block}>
      <h3 className={styles.rowTitle}>Quiet hours</h3>
      <p className={styles.helper}>Alerts are held overnight and sent when quiet hours end. Risk alerts still arrive.</p>
      <p className={styles.note} id="quiet-hours-note">Times are Eastern time (New York) and follow daylight-saving changes. Equal start and end means no quiet period.</p>
      <FieldRow>
        <Field id="quiet-hours-start" label="Quiet hours start"><Input {...time("start")} /></Field>
        <Field id="quiet-hours-end" label="Quiet hours end"><Input {...time("end")} /></Field>
      </FieldRow>
      {validationError && <FieldError id="quiet-hours-error">Enter both quiet-hour times in 24-hour HH:MM format.</FieldError>}
    </div>
  );
}
