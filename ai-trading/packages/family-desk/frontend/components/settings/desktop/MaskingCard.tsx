import { MASK, readMaskValues } from "@/lib/desk/mask";
import type { SettingsRecord } from "@/lib/settings/schema";
import styles from "./settingsDesktop.module.css";

/** `mask_values` (02n §b1, §g.4): whether dollar amounts, share counts and contract counts start hidden on every load. The parent saves it. */
export function MaskingCard({ settings, disabled, onChange }: Readonly<{ settings: SettingsRecord; disabled: boolean; onChange: (masked: boolean) => void }>) {
  const masked = readMaskValues(settings);
  return (
    <section className={styles.card} aria-labelledby="settings-masking" data-testid="settings-masking">
      <h2 id="settings-masking" className={styles.eyebrow}>Masking</h2>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <label className={styles.rowTitle} htmlFor="mask-default">Hide values on every load</label>
          <p className={styles.note} id="mask-default-note">
            Dollar amounts, share counts and contract counts show as {MASK} until you choose Show values in the top bar. Prices, percentages and dates stay visible.
          </p>
        </div>
        <div className={styles.switchGroup}>
          <span className={styles.stateWord}>{masked ? "On" : "Off"}</span>
          <input
            id="mask-default"
            data-testid="mask-default"
            type="checkbox"
            role="switch"
            className={styles.switch}
            checked={masked}
            disabled={disabled}
            aria-describedby="mask-default-note"
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
        </div>
      </div>
    </section>
  );
}
