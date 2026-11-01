"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyBlock, QueryBoundary } from "@/components/ui/StateBlocks";
import { deskFetch } from "@/lib/api/client";
import {
  StrategiesResponseSchema,
  StrategyVersionsResponseSchema,
} from "@/lib/api/schemas";
import { strategyHref } from "@/lib/desk/hrefs";
import { stageLabel, stageTone } from "@/lib/desk/strategyView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "./strategies.module.css";

type Strategy = ReturnType<typeof StrategiesResponseSchema.parse>[number];
type StrategyVersion = ReturnType<typeof StrategyVersionsResponseSchema.parse>[number];
type StrategyRow = { strategy: Strategy; currentVersion: StrategyVersion | null };

async function loadRows(signal: AbortSignal): Promise<StrategyRow[]> {
  const strategies = await deskFetch("/api/desk/strategies", StrategiesResponseSchema, { signal });
  return Promise.all(strategies.map(async (strategy) => {
    if (strategy.current_version_id === null) return { strategy, currentVersion: null };
    const versions = await deskFetch(`/api/desk/strategies/${strategy.id}/versions`, StrategyVersionsResponseSchema, { signal });
    const currentVersion = versions.find(({ id }) => id === strategy.current_version_id);
    if (!currentVersion) throw new Error(`Current version for ${strategy.name} was not returned.`);
    return { strategy, currentVersion };
  }));
}

export function StrategyList() {
  const query = useDeskQuery("strategy-list", loadRows);

  return (
    <section aria-busy={query.loading} className={styles.listSection}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>YOUR DESK</p>
          <h1 className={styles.pageTitle}>Strategies</h1>
        </div>
        <Button variant="primary" href="/strategies/new">New strategy</Button>
      </div>

      <QueryBoundary
        query={query}
        loading="Loading strategies…"
        message="Couldn't load the strategy list."
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyBlock title="No strategies yet" action={{ label: "Browse templates", href: "/strategies/new" }}>
            Start with a template. New strategies are saved as drafts.
          </EmptyBlock>
        }
      >
        {(rows) => (
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
      </QueryBoundary>
    </section>
  );
}
