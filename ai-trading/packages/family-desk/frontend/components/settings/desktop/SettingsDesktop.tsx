"use client";

import { useEffect, useRef, useState } from "react";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { DeskApiError, type DeskApiProblem } from "@/lib/api/client";
import { withMaskValues } from "@/lib/desk/mask";
import { loadChannels, loadSettings, saveSettings } from "@/lib/desk/settings";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { shows, type Lane } from "@/lib/lanes";
import { createSingleFlightSettingsSave, settingsControlsDisabled } from "@/lib/settings/persistence";
import { readCoveredCallSettings } from "@/lib/settings/fundamental";
import {
  mergeOwnedSettings,
  QuietHoursSchema,
  readDefaultView,
  readOwnedSettings,
  readPauseAll,
  withDefaultView,
  withPauseAll,
  type DeliveryPreferences,
  type QuietHours as QuietRange,
  type SettingsRecord,
} from "@/lib/settings/schema";
import { AccountsCard } from "./AccountsCard";
import { AlertTemplatesCard } from "./AlertTemplatesCard";
import { BrokerRowsDisabled } from "./BrokerRowsDisabled";
import { ChannelRows } from "./ChannelRows";
import { DefaultView } from "./DefaultView";
import { HoldingsImportCard } from "./HoldingsImportCard";
import { MarketDataCard } from "./MarketDataCard";
import { MaskingCard } from "./MaskingCard";
import { PauseAll } from "./PauseAll";
import { QuietHours } from "./QuietHours";
import { ScanFiltersCard } from "./ScanFiltersCard";
import styles from "./settingsDesktop.module.css";

type SaveStatus = "idle" | "saving" | "saved" | "error";
type Runner = ReturnType<typeof createSingleFlightSettingsSave>;

/** D11 Settings and More (02m §a3.8, §a3.9). Every write goes through `save`, one request at a time. */
export function SettingsDesktop({ title }: { title: "Settings" | "More" }) {
  const { rememberLane, lane } = useDeskUi();
  const settingsQuery = useDeskQuery("settings", (signal) => loadSettings({ signal }));
  const channelsQuery = useDeskQuery("settings-channels", (signal) => loadChannels({ signal }));
  // The record the last successful save returned; until the first save, the loaded settings.
  const [saved, setSaved] = useState<SettingsRecord | null>(null);
  // Quiet hours as she typed them. A valid draft is the value that is saved, or was about to be.
  const [quietDraft, setQuietDraft] = useState<QuietRange | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  // The record a failed save tried to write, so Retry sends the same change again.
  const [unsaved, setUnsaved] = useState<SettingsRecord | null>(null);
  // The 422 problems of the last failed save, in the server's words (the Fundamental scan filters show them beside their fields).
  const [serverProblems, setServerProblems] = useState<readonly DeskApiProblem[]>([]);
  const runner = useRef<Runner | null>(null);

  useEffect(() => {
    const single = createSingleFlightSettingsSave();
    runner.current = single;
    return () => {
      single.dispose();
      runner.current = null;
    };
  }, []);

  const loaded = saved !== null || settingsQuery.data !== null;
  const settings: SettingsRecord = saved ?? settingsQuery.data?.settings ?? {};
  const owned = readOwnedSettings(settings);
  const quiet = quietDraft ?? owned.quietHours;
  const quietValid = QuietHoursSchema.safeParse(quiet).success;
  // An invalid draft is never sent; the stored quiet hours go out with the other changes instead.
  const quietToSave = quietValid ? quiet : owned.quietHours;
  const saving = saveStatus === "saving";
  const disabled = settingsControlsDisabled({ loading: settingsQuery.loading, saving, hasSettings: loaded });

  async function save(next: SettingsRecord) {
    const single = runner.current;
    if (!single) return;
    setSaveStatus("saving");
    setUnsaved(null);
    setServerProblems([]);
    const result = await single.run(() =>
      saveSettings(next).catch((error: unknown) => {
        if (error instanceof DeskApiError && error.problems.length > 0) setServerProblems(error.problems);
        throw error;
      }),
    );
    if (result.status === "saved") {
      setSaved(result.value.settings);
      setSaveStatus("saved");
    } else if (result.status === "error") {
      setUnsaved(next);
      setSaveStatus("error");
    }
  }

  // Each change starts from the saved record, so one change never overwrites another.
  function edit(change: (base: SettingsRecord) => SettingsRecord) {
    if (loaded) void save(change(settings));
  }

  function saveOwned(channels: DeliveryPreferences) {
    edit((base) => mergeOwnedSettings(base, { quietHours: quietToSave, channels }));
  }

  function changeView(view: Lane) {
    rememberLane(view);
    edit((base) => withDefaultView(base, view));
  }

  const fundamental = shows(lane, "fundamentalSettings");

  function changeQuiet(boundary: keyof QuietRange, value: string) {
    const draft = { ...quiet, [boundary]: value };
    setQuietDraft(draft);
    setSaveStatus("idle");
  }

  // Quiet hours save when a field loses focus: saving on each keystroke disabled the field mid-edit.
  function commitQuiet() {
    const changed = quiet.start !== owned.quietHours.start || quiet.end !== owned.quietHours.end;
    if (quietValid && changed) edit((base) => mergeOwnedSettings(base, { quietHours: quiet, channels: owned.channels }));
  }

  function retry() {
    if (unsaved) void save(unsaved);
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
        <div className={styles.saveStatus} role="status" aria-live="polite">
          {saveStatus === "saving" && <span>Saving…</span>}
          {saveStatus === "saved" && <span className={styles.saved}>Saved</span>}
          {saveStatus === "error" && (
            <>
              <span className={styles.errorText}>Preferences were not saved. Try again.</span>
              <Button onClick={retry} disabled={disabled}>Retry</Button>
            </>
          )}
        </div>
      </header>

      {settingsQuery.data === null && (
        settingsQuery.error === null
          ? <LoadingBlock label="Loading settings…" />
          : <ErrorBlock subject="settings page" onRetry={settingsQuery.refresh} />
      )}

      <div className={styles.stack} aria-busy={disabled}>
        {owned.warnings.length > 0 && (
          <Banner
            tone="warn"
            action={<Button onClick={() => saveOwned(owned.channels)} disabled={disabled}>Repair preferences</Button>}
          >
            Stored preferences were invalid. {owned.warnings.includes("quiet_hours") && "Quiet hours display the safe 22:00–07:00 default. "}
            External delivery is paused for invalid preferences. Change a preference to replace these values.
          </Banner>
        )}

        <section className={styles.card} aria-labelledby="settings-default-view">
          <h2 id="settings-default-view" className={styles.eyebrow}>Default mode</h2>
          <DefaultView value={readDefaultView(settings)} disabled={disabled} onChange={changeView} />
        </section>

        {fundamental && (
          <>
            <MaskingCard settings={settings} disabled={disabled} onChange={(masked) => edit((base) => withMaskValues(base, masked))} />
            <AccountsCard disabled={disabled} />
            <HoldingsImportCard disabled={disabled} />
            <ScanFiltersCard
              key={JSON.stringify(readCoveredCallSettings(settings))}
              settings={settings}
              disabled={disabled}
              serverProblems={serverProblems}
              onSave={edit}
            />
            <AlertTemplatesCard />
          </>
        )}

        <section className={styles.card} aria-labelledby="settings-alerts">
          <h2 id="settings-alerts" className={styles.eyebrow}>Alerts</h2>
          <PauseAll
            paused={readPauseAll(settings)}
            disabled={disabled}
            onChange={(paused) => edit((base) => withPauseAll(base, paused))}
          />
          {channelsQuery.data !== null ? (
            <ChannelRows
              channels={channelsQuery.data}
              preferences={owned.channels}
              disabled={disabled}
              onPreference={(channel, enabled) => saveOwned({ ...owned.channels, [channel]: enabled })}
              onChannelsChanged={channelsQuery.refresh}
            />
          ) : channelsQuery.error === null ? (
            <LoadingBlock label="Loading alert channels…" />
          ) : (
            <ErrorBlock message="Couldn't load alert channels · Try again" onRetry={channelsQuery.refresh} />
          )}
          <QuietHours value={quiet} disabled={disabled} validationError={!quietValid} onChange={changeQuiet} onCommit={commitQuiet} />
        </section>

        <MarketDataCard />

        <section className={styles.card} aria-labelledby="settings-trading">
          <h2 id="settings-trading" className={styles.eyebrow}>Trading</h2>
          <BrokerRowsDisabled />
        </section>
      </div>
    </div>
  );
}
