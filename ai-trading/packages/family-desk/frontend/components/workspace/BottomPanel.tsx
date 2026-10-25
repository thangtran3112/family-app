"use client";

import { useState, type ReactNode } from "react";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { Signal, Technicals } from "@/lib/api/schemas";
import { loadSignals } from "@/lib/desk/charts";
import { formatEtStamp, formatNumber, formatPrice } from "@/lib/desk/format";
import { COPY } from "@/lib/desk/freshness";
import { indicatorName } from "@/lib/desk/labels";
import { countsLine, historyBanner } from "@/lib/desk/summary";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { biasTone, keyLevelRows, signalKindLabel, type KeyLevel } from "@/lib/desk/workspace";
import styles from "./workspacePanels.module.css";

const TABS = [
  { id: "technicals", label: "Technicals" },
  { id: "signals", label: "Signals" },
  { id: "levels", label: "Levels" },
] as const;
type TabId = (typeof TABS)[number]["id"];

type Votes = Technicals["oscillators"];
type Gauge = Technicals["gauges"]["summary"];
type VoteRow = { key: string; name: string; value: number | null; action: string | null };

const VOTE_COLUMNS: DenseColumn<VoteRow>[] = [
  { key: "name", label: "Name", render: (row) => row.name },
  { key: "value", label: "Value", align: "right", render: (row) => formatNumber(row.value) },
  { key: "action", label: "Action", render: (row) => <span className={styles[biasTone(row.action ?? "")]}>{row.action ?? "—"}</span> },
];

const SIGNAL_COLUMNS: DenseColumn<Signal>[] = [
  { key: "bar", label: "Bar time", render: (row) => formatEtStamp(row.bar_time) },
  { key: "strategy", label: "Strategy", render: (row) => row.strategy_name },
  { key: "kind", label: "Kind", render: (row) => signalKindLabel(row.kind) },
];

const LEVEL_COLUMNS: DenseColumn<KeyLevel>[] = [
  { key: "level", label: "Level", render: (row) => row.label },
  { key: "price", label: "Price", align: "right", render: (row) => formatPrice(row.price) },
];

function GaugeItem({ title, gauge }: { title: string; gauge: Gauge }) {
  return (
    <div className={styles.summaryItem}>
      <span className={styles.heading}>{title}</span>
      <strong className={styles[biasTone(gauge.label)]}>{gauge.label}</strong>
      <span className={styles.muted}>{countsLine(gauge.counts)}</span>
    </div>
  );
}

function VoteTable({ title, votes }: { title: string; votes: Votes }) {
  const rows: VoteRow[] = Object.entries(votes).map(([key, vote]) => ({
    key,
    name: indicatorName(key),
    value: Object.values(vote.values).find((item) => item !== null) ?? null,
    action: vote.action,
  }));
  return (
    <section className={styles.voteTable}>
      <h3 className={styles.heading}>{title}</h3>
      <DenseTable caption={title} columns={VOTE_COLUMNS} rows={rows} rowKey={(row) => row.key} density="compact" />
    </section>
  );
}

function TechnicalsBody({ technicals, timeframeLabel }: { technicals: Technicals; timeframeLabel: string }) {
  const banner = historyBanner(technicals, timeframeLabel);
  return (
    <>
      <div className={styles.summaryRow}>
        <GaugeItem title="Summary" gauge={technicals.gauges.summary} />
        <GaugeItem title="Oscillators" gauge={technicals.gauges.oscillators} />
        <GaugeItem title="Moving averages" gauge={technicals.gauges.moving_averages} />
      </div>
      {banner && <p className={styles.muted}>{banner}</p>}
      <div className={styles.tables}>
        <VoteTable title="Oscillators" votes={technicals.oscillators} />
        <VoteTable title="Moving averages" votes={technicals.moving_averages} />
      </div>
      <a href="#summary" className={styles.link}>Open full summary</a>
    </>
  );
}

// Its own component so the signal query only runs while the Signals tab is selected.
function SignalsBody({ symbol }: { symbol: string }) {
  const signals = useDeskQuery(`signals-${symbol}`, (signal) => loadSignals({ symbol, limit: 50 }, { signal }), { intervalMs: 60_000 });
  const rows = signals.data;
  if (rows === null) {
    return signals.error === null ? <LoadingBlock label="Loading signals…" /> : <ErrorBlock subject="signal list" onRetry={signals.refresh} />;
  }
  if (rows.length === 0) return <EmptyBlock title={COPY.noSignalsToday} />;
  return <DenseTable caption="Signals" columns={SIGNAL_COLUMNS} rows={rows} rowKey={(row) => String(row.id)} density="compact" />;
}

function LevelsBody({ technicals }: { technicals: Technicals | null }) {
  const rows = keyLevelRows(technicals);
  if (rows.length === 0) return <p className={styles.muted}>Levels are not available yet</p>;
  return <DenseTable caption="Key levels" columns={LEVEL_COLUMNS} rows={rows} rowKey={(row) => row.label} density="compact" />;
}

export function BottomPanel({
  symbol,
  timeframeLabel,
  technicals,
  collapsed,
  onToggle,
}: {
  symbol: string;
  timeframeLabel: string;
  technicals: Technicals | null;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [tab, setTab] = useState<TabId>("technicals");

  let body: ReactNode;
  if (tab === "technicals") {
    body = technicals ? <TechnicalsBody technicals={technicals} timeframeLabel={timeframeLabel} /> : <LoadingBlock label="Loading technicals…" />;
  } else if (tab === "signals") {
    body = <SignalsBody symbol={symbol} />;
  } else {
    body = <LevelsBody technicals={technicals} />;
  }

  return (
    <section className={styles.bottom} aria-label="Chart panels">
      <div className={styles.tabBar}>
        <div role="tablist" aria-label="Panels" className={styles.tabs}>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={styles.tab}
              onClick={() => {
                setTab(item.id);
                if (collapsed) onToggle();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.collapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand panel" : "Collapse panel"}
          onClick={onToggle}
        >
          {collapsed ? "▴" : "▾"}
        </button>
      </div>
      {!collapsed && <div role="tabpanel" className={styles.bottomBody}>{body}</div>}
    </section>
  );
}
