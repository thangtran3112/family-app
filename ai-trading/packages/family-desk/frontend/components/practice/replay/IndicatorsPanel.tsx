"use client";

import { useMemo } from "react";
import { RailList, RailValue } from "@/components/ui/RailList";
import type { ChartBar } from "@/lib/chart-data";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { indicatorGroups } from "@/lib/replay/indicatorsView";
import type { SessionVwap } from "@/lib/replay/sessionVwap";
import styles from "./replay.module.css";

/**
 * The replay's left rail (owner, 2026-11-01): RSI and MACD, then VWAP and the two EMAs against the price, each with a word for what it
 * says. The numbers are read off the bars shown on the chart, so they move as the replay does and never look ahead. `timeframe` names
 * the candle they are computed on ("15m", "Daily").
 */
export function IndicatorsPanel({ bars, interval, timeframe, vwap }: { bars: readonly ChartBar[]; interval: string; timeframe: string; /** The session VWAP of these bars, built from one-minute bars (D-168); left out, it is computed from `bars`. */ vwap?: SessionVwap }) {
  const groups = useMemo(() => indicatorGroups(bars, interval, vwap), [bars, interval, vwap]);
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
