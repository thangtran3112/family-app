"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, FieldRow, NumberInput } from "@/components/ui/Field";
import type { DeskApiProblem } from "@/lib/api/client";
import {
  COVERED_CALL_DEFAULTS, withCoveredCallSettings,
} from "@/lib/settings/fundamental";
import {
  SCAN_FIELDS, scanDefaultsDraft, scanDraftChanged, scanDraftFromSettings, scanProblemsOfDraft, scanSettingsOfDraft, serverProblemsToFields,
  type ScanDraft,
} from "@/lib/settings/fundamentalView";
import type { SettingsRecord } from "@/lib/settings/schema";
import styles from "./settingsDesktop.module.css";

type Props = Readonly<{
  settings: SettingsRecord;
  disabled: boolean;
  /** The 422 problems of the last failed save, in the server's words. */
  serverProblems: readonly DeskApiProblem[];
  onSave: (change: (base: SettingsRecord) => SettingsRecord) => void;
}>;

/**
 * The cover-scan filters and the cover cap (02n §b3 FD11, 02 §6.3 defaults). The numbers are only edited here: the engine
 * applies them. An invalid draft is never sent; the parent remounts this card (a new `key`) when the saved values change.
 */
export function ScanFiltersCard({ settings, disabled, serverProblems, onSave }: Props) {
  const saved = scanDraftFromSettings(settings);
  const [draft, setDraft] = useState<ScanDraft>(saved);
  // The server's problems show until the next edit.
  const [dismissed, setDismissed] = useState<readonly DeskApiProblem[] | null>(null);
  const problems = scanProblemsOfDraft(draft);
  const server = dismissed === serverProblems ? {} : serverProblemsToFields(serverProblems);
  const changed = scanDraftChanged(draft, saved);
  const invalid = Object.keys(problems).length > 0;

  function edit(key: keyof ScanDraft, value: string) {
    setDraft({ ...draft, [key]: value });
    setDismissed(serverProblems);
  }

  return (
    <section className={styles.card} aria-labelledby="settings-scan-filters" data-testid="settings-scan-filters">
      <h2 id="settings-scan-filters" className={styles.eyebrow}>Covered-call scan filters</h2>
      <p className={styles.helper}>The scan keeps only calls inside these limits. The defaults are the Desk&apos;s own: {COVERED_CALL_DEFAULTS.min_dte} to {COVERED_CALL_DEFAULTS.max_dte} days, delta {COVERED_CALL_DEFAULTS.min_delta} to {COVERED_CALL_DEFAULTS.max_delta}, cover up to {COVERED_CALL_DEFAULTS.cap_pct}% of the shares.</p>
      <div className={styles.fieldGrid}>
        {SCAN_FIELDS.map((field) => (
          <Field key={field.key} id={`scan-${field.key}`} label={field.label} error={problems[field.key] ?? server[field.key]}>
            <NumberInput
              data-testid={`scan-${field.key}`}
              inputMode="decimal"
              step={field.step}
              value={draft[field.key]}
              disabled={disabled}
              onChange={(event) => edit(field.key, event.currentTarget.value)}
            />
          </Field>
        ))}
      </div>
      <FieldRow>
        <Button variant="primary" data-testid="scan-save" disabled={disabled || invalid || !changed} onClick={() => onSave((base) => withCoveredCallSettings(base, scanSettingsOfDraft(draft)))}>
          Save filters
        </Button>
        <Button data-testid="scan-reset" disabled={disabled} onClick={() => { setDraft(scanDefaultsDraft()); setDismissed(serverProblems); }}>
          Reset to defaults
        </Button>
      </FieldRow>
    </section>
  );
}
