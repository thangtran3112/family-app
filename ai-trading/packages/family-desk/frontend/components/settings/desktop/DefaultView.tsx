import { LANE_LABEL, LANES, type Lane } from "@/lib/lanes";
import styles from "./settingsDesktop.module.css";

/** Which mode the Desk opens on (`default_view`, 02m §a3.9, ADR-0014). The parent saves it; this screen stays put. */
export function DefaultView({ value, disabled, onChange }: Readonly<{ value: Lane; disabled: boolean; onChange: (view: Lane) => void }>) {
  return (
    <fieldset className={styles.radios} disabled={disabled}>
      <legend className={styles.visuallyHidden}>Default mode</legend>
      {LANES.map((lane) => (
        <label className={styles.option} key={lane}>
          <input type="radio" name="default-view" value={lane} checked={value === lane} onChange={() => onChange(lane)} />
          <span>{LANE_LABEL[lane]}</span>
        </label>
      ))}
    </fieldset>
  );
}
