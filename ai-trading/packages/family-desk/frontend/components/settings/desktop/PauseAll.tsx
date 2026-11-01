import { Switch } from "@/components/ui/Field";
import styles from "./settingsDesktop.module.css";

/** Stops every alert strategy while on (`pause_all`, 02m §a3.9). The parent saves it. */
export function PauseAll({ paused, disabled, onChange }: Readonly<{ paused: boolean; disabled: boolean; onChange: (paused: boolean) => void }>) {
  return (
    <div className={styles.row} id="settings-strategies">
      <div className={styles.rowText}>
        <label className={styles.rowTitle} htmlFor="pause-all">Pause all strategies</label>
        <p className={styles.note} id="pause-all-note">Stops every alert strategy from firing until you turn it back on.</p>
      </div>
      <div className={styles.switchGroup}>
        <span className={styles.stateWord}>{paused ? "On" : "Off"}</span>
        <Switch
          id="pause-all"
          checked={paused}
          disabled={disabled}
          aria-describedby="pause-all-note"
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      </div>
    </div>
  );
}
