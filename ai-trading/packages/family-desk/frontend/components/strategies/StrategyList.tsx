"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { deskFetch } from "@/lib/api/client";
import {
  StrategiesResponseSchema,
  StrategyVersionsResponseSchema,
} from "@/lib/api/schemas";
import { stageLabel, stageTone } from "@/lib/desk/strategyView";
import styles from "./strategies.module.css";
import { strategyHref } from "@/lib/desk/hrefs";

type Strategy = ReturnType<typeof StrategiesResponseSchema.parse>[number];
type StrategyVersion = ReturnType<typeof StrategyVersionsResponseSchema.parse>[number];
type StrategyRow = { strategy: Strategy; currentVersion: StrategyVersion | null };

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
        <Button variant="primary" href="/strategies/new">New strategy</Button>
      </div>

      {loading && <p aria-live="polite" className={styles.feedback}>Loading strategies…</p>}
      {error && (
        <Banner tone="down" action={<Button onClick={retry}>Try again</Button>}>{error}</Banner>
      )}
      {!loading && !error && rows.length === 0 && (
        <div className={styles.emptyState}>
          <h2>No strategies yet</h2>
          <p>Start with a template. New strategies are saved as drafts.</p>
          <Button variant="primary" href="/strategies/new">Browse templates</Button>
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
                    <a className={styles.strategyName} href={strategyHref(strategy.id)}>
                      {strategy.name}
                    </a>
                  </td>
                  <td data-label="Stage">
                    <Badge tone={stageTone(strategy.stage)}>{stageLabel(strategy.stage)}</Badge>
                  </td>
                  <td data-label="Current version">
                    {currentVersion
                      ? `v${currentVersion.version}`
                      : <span className={styles.noVersion}>No version <a href={strategyHref(strategy.id)}>Add version</a></span>}
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
