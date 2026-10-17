"use client";

import { useEffect, useState } from "react";
import { Channels } from "../../components/settings/Channels.tsx";
import { Fixtures } from "../../components/settings/Fixtures.tsx";
import { SourcesStatus } from "../../components/settings/SourcesStatus.tsx";
import styles from "../../components/settings/Settings.module.css";
import { deskFetch } from "../../lib/api/client.ts";
import { SettingsBodySchema } from "../../lib/api/schemas.ts";
import {
  mergeOwnedSettings,
  QuietHoursSchema,
  readOwnedSettings,
  type DeliveryPreferences,
  type QuietHours,
  type SettingsRecord,
} from "../../lib/settings/schema.ts";

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsRecord | null>(null);
  const [quietHours, setQuietHours] = useState<QuietHours>({ start: "22:00", end: "07:00" });
  const [channels, setChannels] = useState<DeliveryPreferences>({ telegram: true, slack: true });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [validationError, setValidationError] = useState(false);

  useEffect(() => {
    let active = true;
    void deskFetch("/api/desk/settings", SettingsBodySchema)
      .then(({ settings: loaded }) => {
        if (!active) return;
        setSettings(loaded);
        const owned = readOwnedSettings(loaded);
        setQuietHours(owned.quietHours);
        setChannels(owned.channels);
        setWarnings(owned.warnings);
      })
      .catch(() => { if (active) setLoadError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  function updateQuietHours(boundary: keyof QuietHours, value: string) {
    const updated = { ...quietHours, [boundary]: value };
    setQuietHours(updated);
    setSaved(false);
    if (!QuietHoursSchema.safeParse(updated).success) {
      setValidationError(true);
      return;
    }
    setValidationError(false);
    void savePreferences(updated, channels);
  }

  function updateChannel(channel: keyof DeliveryPreferences, enabled: boolean) {
    const updated = { ...channels, [channel]: enabled };
    setChannels(updated);
    setSaved(false);
    void savePreferences(quietHours, updated);
  }

  async function savePreferences(
    nextQuietHours: QuietHours = quietHours,
    nextChannels: DeliveryPreferences = channels,
  ) {
    if (!settings) return;
    if (!QuietHoursSchema.safeParse(nextQuietHours).success) {
      setValidationError(true);
      setSaved(false);
      return;
    }

    setSaving(true);
    setSaveError(false);
    setValidationError(false);
    setSaved(false);
    try {
      const updated = mergeOwnedSettings(settings, { quietHours: nextQuietHours, channels: nextChannels });
      const response = await deskFetch("/api/desk/settings", SettingsBodySchema, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: updated }),
      });
      setSettings(response.settings);
      const owned = readOwnedSettings(response.settings);
      setQuietHours(owned.quietHours);
      setChannels(owned.channels);
      setWarnings(owned.warnings);
      setSaved(true);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  async function retryLoad() {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await deskFetch("/api/desk/settings", SettingsBodySchema);
      setSettings(response.settings);
      const owned = readOwnedSettings(response.settings);
      setQuietHours(owned.quietHours);
      setChannels(owned.channels);
      setWarnings(owned.warnings);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.main}>
        <header className={styles.header}>
          <h1>Settings</h1>
          <p>Your alert preferences and current Desk status.</p>
        </header>

        {loadError && (
          <div className={styles.error} role="alert">
            <p>Settings could not be loaded. Your changes are not saved.</p>
            <button className={styles.retryButton} type="button" onClick={() => void retryLoad()} disabled={loading}>Retry</button>
          </div>
        )}

        <div className={styles.form} aria-busy={loading || saving}>
          {warnings.length > 0 && (
            <div className={styles.warning} role="status">
              Stored preferences were invalid. {warnings.includes("quiet_hours") && "Quiet hours display the safe 22:00–07:00 default. "}
              External delivery is paused for invalid preferences. Change a preference to replace these values.
              <button className={styles.retryButton} type="button" onClick={() => void savePreferences()} disabled={loading || saving || !settings}>
                Repair preferences
              </button>
            </div>
          )}
          <section className={styles.section} aria-labelledby="alerts-title">
            <h2 id="alerts-title" className={styles.eyebrow}>Alerts</h2>
            <Channels
              channels={channels}
              quietHours={quietHours}
              disabled={loading || saving || !settings}
              validationError={validationError}
              onChannelChange={updateChannel}
              onQuietHoursChange={updateQuietHours}
            />
          </section>
          {validationError && <p className={styles.error} id="quiet-hours-validation-error" role="alert">Enter both quiet-hour times in 24-hour HH:MM format.</p>}
          {saveError && (
            <div className={styles.error} role="alert">
              <p>Preferences were not saved. Check your connection and try again.</p>
              <button className={styles.retryButton} type="button" onClick={() => void savePreferences()} disabled={loading || saving || !settings}>Retry save</button>
            </div>
          )}
          <div className={styles.saveRow} role="status" aria-live="polite">
            {saving && <p className={styles.statusNote}>Saving preferences…</p>}
            {!saving && saved && <p className={styles.saved}>Saved</p>}
          </div>
        </div>

        <Fixtures />
      </div>
      <SourcesStatus />
    </main>
  );
}
