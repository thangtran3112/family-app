"use client";

import { useEffect, useRef, useState } from "react";
import { Channels } from "./Channels.tsx";
import { Fixtures } from "./Fixtures.tsx";
import { SourcesStatus } from "./SourcesStatus.tsx";
import styles from "./Settings.module.css";
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
import { createSingleFlightSettingsSave, settingsControlsDisabled } from "../../lib/settings/persistence.ts";

export function SettingsMobile() {
  const [settings, setSettings] = useState<SettingsRecord | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [quietHours, setQuietHours] = useState<QuietHours>({ start: "22:00", end: "07:00" });
  const [channels, setChannels] = useState<DeliveryPreferences>({ telegram: true, slack: true });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [validationError, setValidationError] = useState(false);
  const mounted = useRef(false);
  const saveRunner = useRef<ReturnType<typeof createSingleFlightSettingsSave> | null>(null);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    const runner = createSingleFlightSettingsSave();
    saveRunner.current = runner;
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
    return () => {
      active = false;
      mounted.current = false;
      runner.dispose();
      if (saveRunner.current === runner) saveRunner.current = null;
    };
  }, []);

  function updateQuietHours(boundary: keyof QuietHours, value: string) {
    const updated = { ...quietHours, [boundary]: value };
    setQuietHours(updated);
    setSaveStatus("idle");
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
    setSaveStatus("idle");
    void savePreferences(quietHours, updated);
  }

  async function savePreferences(
    nextQuietHours: QuietHours = quietHours,
    nextChannels: DeliveryPreferences = channels,
  ) {
    const runner = saveRunner.current;
    if (!settings || !runner || !mounted.current) return;
    if (!QuietHoursSchema.safeParse(nextQuietHours).success) {
      setValidationError(true);
      return;
    }

    setSaveStatus("saving");
    setValidationError(false);
    const updated = mergeOwnedSettings(settings, { quietHours: nextQuietHours, channels: nextChannels });
    const result = await runner.run(() => deskFetch("/api/desk/settings", SettingsBodySchema, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: updated }),
      }));
    if (result.status === "saved" && mounted.current) {
      setSettings(result.value.settings);
      const owned = readOwnedSettings(result.value.settings);
      setQuietHours(owned.quietHours);
      setChannels(owned.channels);
      setWarnings(owned.warnings);
      setSaveStatus("saved");
    } else if (result.status === "error" && mounted.current) {
      setSaveStatus("error");
    }
  }

  async function retryLoad() {
    if (!mounted.current) return;
    setLoading(true);
    setLoadError(false);
    try {
      const response = await deskFetch("/api/desk/settings", SettingsBodySchema);
      if (!mounted.current) return;
      setSettings(response.settings);
      const owned = readOwnedSettings(response.settings);
      setQuietHours(owned.quietHours);
      setChannels(owned.channels);
      setWarnings(owned.warnings);
    } catch {
      if (mounted.current) setLoadError(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  const saving = saveStatus === "saving";
  const controlsDisabled = settingsControlsDisabled({ loading, saving, hasSettings: settings !== null });

  return (
    <div className={styles.page}>
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
              <button className={styles.retryButton} type="button" onClick={() => void savePreferences()} disabled={controlsDisabled}>
                Repair preferences
              </button>
            </div>
          )}
          <section className={styles.section} aria-labelledby="alerts-title">
            <h2 id="alerts-title" className={styles.eyebrow}>Alerts</h2>
            <Channels
              channels={channels}
              quietHours={quietHours}
              disabled={controlsDisabled}
              validationError={validationError}
              onChannelChange={updateChannel}
              onQuietHoursChange={updateQuietHours}
            />
          </section>
          {validationError && <p className={styles.error} id="quiet-hours-validation-error" role="alert">Enter both quiet-hour times in 24-hour HH:MM format.</p>}
          {saveStatus === "error" && (
            <div className={styles.error} role="alert">
              <p>Preferences were not saved. Check your connection and try again.</p>
              <button className={styles.retryButton} type="button" onClick={() => void savePreferences()} disabled={controlsDisabled}>Retry save</button>
            </div>
          )}
          <div className={styles.saveRow} role="status" aria-live="polite">
            {saving && <p className={styles.statusNote}>Saving preferences…</p>}
            {saveStatus === "saved" && <p className={styles.saved}>Saved</p>}
          </div>
        </div>

        <Fixtures />
      </div>
      <SourcesStatus />
    </div>
  );
}
