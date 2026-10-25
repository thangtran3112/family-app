"use client";

import type { ReactNode } from "react";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadAlertStrategies } from "@/lib/desk/alerts";
import { loadFilters } from "@/lib/desk/screener";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { MAX_ARMED, toggleArmed, type ArmedRef } from "@/lib/replay/setup";
import { describeSpec, runLabels } from "@/lib/spec/describe";
import { parseAlertSpec } from "@/lib/spec/parse";
import styles from "./hub.module.css";

type ArmRow = { ref: ArmedRef; name: string; rule: string; kind: "Alert" | "Filter" };

/** Her alert strategies and filters as checkboxes, up to five armed. An alert shows its plain-English rule; a filter
 *  list row carries no spec, so it shows when it runs and which session instead. */
export function ArmStrategiesField({ armed, onChange, error }: { armed: readonly ArmedRef[]; onChange: (armed: ArmedRef[]) => void; error?: string }) {
  const alerts = useDeskQuery("practice:alert-strategies", (signal) => loadAlertStrategies({}, { signal }));
  const filters = useDeskQuery("practice:filters", (signal) => loadFilters({ signal }));
  const failed = (alerts.data === null && alerts.error !== null) || (filters.data === null && filters.error !== null);
  const loading = alerts.loading || filters.loading;

  const rows: ArmRow[] = [
    ...(alerts.data ?? []).map((row) => {
      const parsed = parseAlertSpec(row.spec);
      return { ref: { source: "alert_strategy", id: row.id }, name: row.name, rule: parsed ? describeSpec(parsed) : "", kind: "Alert" } satisfies ArmRow;
    }),
    ...(filters.data ?? []).map((row) => ({
      ref: { source: "filter", id: row.id },
      name: row.name,
      rule: `At ${runLabels[row.run_on]} during ${row.session === "regular" ? "regular hours" : "extended hours"}`,
      kind: "Filter",
    }) satisfies ArmRow),
  ];

  const isArmed = (ref: ArmedRef) => armed.some((item) => item.source === ref.source && item.id === ref.id);
  const full = armed.length >= MAX_ARMED;

  let body: ReactNode;
  if (failed) {
    body = <ErrorBlock subject="strategy list" onRetry={() => { alerts.refresh(); filters.refresh(); }} />;
  } else if (loading) {
    body = <LoadingBlock label="Loading your strategies…" height={64} />;
  } else if (rows.length === 0) {
    body = <p className={styles.hint}>No alert strategies or filters yet · you can still practice without arming</p>;
  } else {
    body = (
      <ul className={styles.armList}>
        {rows.map((row) => {
          const checked = isArmed(row.ref);
          const disabled = !checked && full;
          return (
            <li key={`${row.ref.source}:${row.ref.id}`}>
              <label className={styles.armRow} data-disabled={disabled ? "true" : undefined}>
                <input
                  type="checkbox"
                  className={styles.check}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChange(toggleArmed(armed, row.ref))}
                />
                <span className={styles.armText}>
                  <span className={styles.armName}>{row.name}</span>
                  {row.rule && <span className={styles.armRule}>{row.rule}</span>}
                </span>
                <span className={styles.chip}>{row.kind}</span>
              </label>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <fieldset className={styles.group} aria-describedby={error ? "arm-error" : undefined}>
      <legend className={styles.legend}>Arm strategies</legend>
      <p className={styles.hint}>Arm up to {MAX_ARMED} strategies · {armed.length} armed</p>
      {body}
      {error && <p id="arm-error" role="alert" className={styles.fieldError}>{error}</p>}
    </fieldset>
  );
}
