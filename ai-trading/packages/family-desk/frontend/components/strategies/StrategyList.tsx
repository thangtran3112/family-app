"use client";

import { useCallback, useEffect, useState } from "react";
import { deskFetch } from "@/lib/api/client";
import {
  StrategiesResponseSchema,
  StrategyVersionsResponseSchema,
} from "@/lib/api/schemas";
import styles from "./strategies.module.css";

type Strategy = ReturnType<typeof StrategiesResponseSchema.parse>[number];
type StrategyVersion = ReturnType<typeof StrategyVersionsResponseSchema.parse>[number];
type StrategyRow = { strategy: Strategy; currentVersion: StrategyVersion | null };

function stageLabel(stage: string): string {
  return ({ draft: "Draft", alert_only: "Alert only", paper: "Paper" } as Record<string, string>)[stage]
    ?? stage.replaceAll("_", " ");
}

export function StrategyList() {
  const [rows, setRows] = useState<StrategyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadRows = useCallback(async () => {
    const strategies = await deskFetch("/api/desk/strategies", StrategiesResponseSchema);
    return Promise.all(strategies.map(async (strategy) => {
      if (strategy.current_version_id === null) return { strategy, currentVersion: null };
      const versions = await deskFetch(
        `/api/desk/strategies/${strategy.id}/versions`,
        StrategyVersionsResponseSchema,
      );
      const currentVersion = versions.find(({ id }) => id === strategy.current_version_id);
      if (!currentVersion) throw new Error(`Current version for ${strategy.name} was not returned.`);
      return { strategy, currentVersion };
    }));
  }, []);

  const retry = useCallback(() => {
    setLoading(true);
    setError("");
    void loadRows().then(setRows).catch(() => {
      setError("Couldn't load the strategy list.");
    }).finally(() => setLoading(false));
  }, [loadRows]);

  useEffect(() => {
    let active = true;
    void loadRows().then((result) => {
      if (active) setRows(result);
    }).catch(() => {
      if (active) setError("Couldn't load the strategy list.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadRows]);

  return (
    <section aria-busy={loading} className={styles.listSection}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>YOUR DESK</p>
          <h1 className={styles.pageTitle}>Strategies</h1>
        </div>
        <a className={styles.primaryLink} href="/strategies/new">New strategy</a>
      </div>

      {loading && <p aria-live="polite" className={styles.feedback}>Loading strategies…</p>}
      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button className={styles.secondaryButton} onClick={retry} type="button">Try again</button>
        </div>
      )}
      {!loading && !error && rows.length === 0 && (
        <div className={styles.emptyState}>
          <h2>No strategies yet</h2>
          <p>Start with a template. New strategies are saved as drafts.</p>
          <a className={styles.primaryLink} href="/strategies/new">Browse templates</a>
        </div>
      )}
      {!loading && !error && rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.strategyTable}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Stage</th>
                <th scope="col">Current version</th>
                <th scope="col">30-day paper P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ strategy, currentVersion }) => (
                <tr key={strategy.id}>
                  <td data-label="Name">
                    <a className={styles.strategyName} href={`/strategies?id=${strategy.id}`}>
                      {strategy.name}
                    </a>
                  </td>
                  <td data-label="Stage">
                    <span className={`${styles.stageBadge} ${styles[`stage_${strategy.stage}`] ?? ""}`}>
                      {stageLabel(strategy.stage)}
                    </span>
                  </td>
                  <td data-label="Current version">
                    {currentVersion
                      ? `v${currentVersion.version}`
                      : <span className={styles.noVersion}>No version <a href={`/strategies?id=${strategy.id}`}>Add version</a></span>}
                  </td>
                  <td data-label="30-day paper P&amp;L">
                    <span className={styles.fixtureValue}>Needs broker setup</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
