"use client";

import { useMemo } from "react";
import { RailList, RailValue } from "@/components/ui/RailList";
import type { ChartBar } from "@/lib/chart-data";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { ServerSeries } from "@/lib/desk/workspace";
import { indicatorGroups } from "@/lib/replay/indicatorsView";
import styles from "./replay.module.css";

/**
 * The replay's left rail (owner, 2026-11-01): RSI and MACD, then VWAP and the two EMAs against the price, each with a word for what it
 * says. The numbers are the server's, from the same cut as the chart and the price, so they move as the replay does and never look ahead. `timeframe` names
 * the candle they are computed on ("15m", "Daily").
 */
export function IndicatorsPanel({ bars, interval, timeframe, server }: { bars: readonly ChartBar[]; interval: string; timeframe: string; /** The server's indicator rows laid on `bars` (ADR-0022); left out (the Daily view), the values are computed from `bars`. */ server?: ServerSeries }) {
  const groups = useMemo(() => indicatorGroups(bars, interval, server), [bars, interval, server]);
  return (
    <section className={styles.sessionSection} aria-label={PRACTICE_COPY.indicatorsTitle} data-testid="indicators-panel">
      <div className={styles.railHead}>
        <h2 className={styles.railTitle}>{PRACTICE_COPY.indicatorsTitle}</h2>
        <span className={styles.railHint}>{timeframe}</span>
      </div>
      {groups.map((group) => (
        <div key={group.id} className={styles.indicatorGroup}>
          <h3 className={styles.sectionTitle}>{group.title}</h3>
          <RailList
            size="md"
            divided
            label={group.title}
            rows={group.rows.map((row) => ({
              id: row.id,
              label: row.name,
              value: row.value,
              sub: row.state === "" ? undefined : <RailValue tone={row.tone}>{row.state}</RailValue>,
            }))}
          />
        </div>
      ))}
      <p className={styles.footnote}>{PRACTICE_COPY.indicatorsFootnote}</p>
    </section>
  );
}
