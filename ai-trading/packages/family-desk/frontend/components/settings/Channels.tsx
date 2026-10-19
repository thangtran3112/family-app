import type { DeliveryPreferences, QuietHours } from "../../lib/settings/schema.ts";
import styles from "./Settings.module.css";

export function Channels({
  channels,
  quietHours,
  disabled,
  validationError,
  onChannelChange,
  onQuietHoursChange,
}: Readonly<{
  channels: DeliveryPreferences;
  quietHours: QuietHours;
  disabled: boolean;
  validationError: boolean;
  onChannelChange: (channel: keyof DeliveryPreferences, enabled: boolean) => void;
  onQuietHoursChange: (boundary: keyof QuietHours, value: string) => void;
}>) {
  return (
    <div className={styles.preferences}>
      <p className={styles.helper}>Inbox is always on. External channel settings are preferences only; their configuration status is not exposed.</p>
      <fieldset className={styles.channelFieldset} disabled={disabled}>
        <legend className={styles.visuallyHidden}>Alert channels</legend>
        <label className={styles.channelRow}>
          <span className={styles.channelName}>Desk inbox</span>
          <span className={styles.channelDescription}>Alerts remain available in your inbox.</span>
          <span className={styles.checkTarget}>
            <input type="checkbox" checked disabled aria-label="Desk inbox always on" />
          </span>
        </label>
        <label className={styles.channelRow}>
          <span className={styles.channelName}>Telegram</span>
          <span className={styles.channelDescription}>Choose whether alerts may use Telegram.</span>
          <span className={styles.checkTarget}>
            <input
              type="checkbox"
              checked={channels.telegram}
              onChange={(event) => onChannelChange("telegram", event.currentTarget.checked)}
            />
          </span>
        </label>
        <label className={styles.channelRow}>
          <span className={styles.channelName}>Slack</span>
          <span className={styles.channelDescription}>Choose whether alerts may use Slack.</span>
          <span className={styles.checkTarget}>
            <input
              type="checkbox"
              checked={channels.slack}
              onChange={(event) => onChannelChange("slack", event.currentTarget.checked)}
            />
          </span>
        </label>
      </fieldset>

      <section className={styles.quietSection} aria-labelledby="quiet-hours-title">
        <div>
          <h3 id="quiet-hours-title" className={styles.rowTitle}>Quiet hours</h3>
          <p className={styles.helper}>Overnight window for channel messages. Risk and system alerts still bypass quiet hours.</p>
          <p className={styles.helper} id="quiet-hours-help">Times save as 24-hour HH:MM in America/New_York, including daylight-saving changes. Equal start and end means no quiet period.</p>
        </div>
        <div className={styles.timeFields}>
          <label className={styles.timeField} htmlFor="quiet-hours-start">
            <span>Start</span>
            <input
              id="quiet-hours-start"
              type="time"
              step={60}
              required
              disabled={disabled}
              aria-describedby={validationError ? "quiet-hours-validation-error" : "quiet-hours-help"}
              value={quietHours.start}
              onChange={(event) => onQuietHoursChange("start", event.currentTarget.value)}
            />
          </label>
          <label className={styles.timeField} htmlFor="quiet-hours-end">
            <span>End</span>
            <input
              id="quiet-hours-end"
              type="time"
              step={60}
              required
              disabled={disabled}
              aria-describedby={validationError ? "quiet-hours-validation-error" : "quiet-hours-help"}
              value={quietHours.end}
              onChange={(event) => onQuietHoursChange("end", event.currentTarget.value)}
            />
          </label>
        </div>
      </section>
    </div>
  );
}
