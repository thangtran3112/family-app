"use client";

import { useRouter } from "next/navigation";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { EMPTY_VALUE } from "@/lib/desk/format";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { formatUsd, moneyTone } from "@/lib/replay/journalView";
import type { ReplaySessionSummary } from "@/lib/replay/schemas";
import styles from "./hub.module.css";

// Five columns fit the 320 px rail: the attempt rides with the symbol, and an open session is marked with a dot.
const COLUMNS: DenseColumn<ReplaySessionSummary>[] = [
  {
    key: "day",
    label: "Day",
    render: (row) => (
      <>
        {row.status === "active" && <span className={styles.openDot} role="img" aria-label="Session still open" title="Session still open" />}
        {row.hide_date === "yes" ? PRACTICE_COPY.hiddenDay : row.day}
      </>
    ),
  },
  { key: "symbol", label: "Symbol", render: (row) => (row.attempt > 1 ? `${row.symbol} #${row.attempt}` : row.symbol) },
  { key: "trades", label: "Trades", align: "right", render: (row) => String(row.trades) },
  { key: "pnl", label: "P/L", align: "right", render: (row) => <span className={styles[moneyTone(row.pnl_usd)]}>{formatUsd(row.pnl_usd)}</span> },
  { key: "adherence", label: "Adh.", align: "right", render: (row) => (row.adherence_pct == null ? EMPTY_VALUE : `${row.adherence_pct}%`) },
];

/** Recent sessions; a row opens its journal. Scrolls sideways in the 320 px rail rather than cutting columns. */
export function RecentSessionsTable({
  sessions,
  loading,
  error,
  onRetry,
}: {
  sessions: readonly ReplaySessionSummary[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const router = useRouter();
  if (error !== null) return <ErrorBlock message={PRACTICE_COPY.loadError} onRetry={onRetry} />;
  if (loading) return <LoadingBlock label="Loading practice sessions…" height={96} />;
  return (
    <DenseTable
      caption="Recent practice sessions"
      density="compact"
      scrollX
      columns={COLUMNS}
      rows={sessions}
      rowKey={(row) => String(row.id)}
      onSelect={(row) => router.push(`/practice/journal?id=${row.id}`)}
      empty={<EmptyBlock title={PRACTICE_COPY.noSessions} />}
    />
  );
}
