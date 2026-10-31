"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";

import type { AlertStrategy } from "@/lib/api/schemas";
import { pauseAlertStrategy, resumeAlertStrategy } from "@/lib/desk/alerts";
import {
  actionError,
  actionFor,
  actionLabel,
  channelsText,
  lastFiredText,
  sourceText,
  statusText,
  statusTone,
  triggerText,
  type RowAction,
} from "@/lib/desk/alertsView";
import styles from "./alerts.module.css";

/** Pause, or resume. A draft's "Turn on" is a resume too (02m §a3.7). */
export const runRowAction = (action: Exclude<RowAction, null>, id: number) =>
  action === "pause" ? pauseAlertStrategy(id) : resumeAlertStrategy(id);

const FREQUENCY_SHORT = { once: "Once", once_per_bar: "Per bar", every_time: "Every time" } as const;

const columns: DenseColumn<AlertStrategy>[] = [
  { key: "name", label: "Name", render: (row) => <span className={styles.name}>{row.name}</span> },
  { key: "source", label: "Source", render: (row) => <span title={sourceText(row.source)}>{row.source.label}</span> },
  {
    key: "trigger",
    label: "Trigger",
    render: (row) => {
      const text = triggerText(row);
      return <span className={styles.clip} title={text}>{text}</span>;
    },
  },
  { key: "frequency", label: "Frequency", priority: 2, render: (row) => FREQUENCY_SHORT[row.frequency] },
  { key: "channels", label: "Channels", priority: 1, render: (row) => channelsText(row.channels) },
  { key: "status", label: "Status", render: (row) => <Badge tone={statusTone(row.status)}>{statusText(row)}</Badge> },
  {
    key: "last_fired",
    label: "Last fired",
    render: (row) => lastFiredText(row.last_fired_at),
    sortValue: (row) => row.last_fired_at,
    firstSort: "desc",
  },
];

export function AlertTable({
  rows,
  selectedId,
  onSelect,
  onChanged,
}: {
  rows: AlertStrategy[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(row: AlertStrategy, action: Exclude<RowAction, null>) {
    setBusy(row.id);
    setError(null);
    try {
      await runRowAction(action, row.id);
      onChanged();
    } catch (cause) {
      setError(actionError(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <DenseTable
        caption="Alert strategies"
        density="compact"
        columns={columns}
        rows={rows}
        rowKey={(row) => String(row.id)}
        selectedKey={selectedId === null ? null : String(selectedId)}
        onSelect={(row) => onSelect(row.id)}
        rowActions={(row) => {
          const action = actionFor(row);
          if (!action) return null;
          return (
            <Button size="sm" loading={busy === row.id} onClick={() => act(row, action)}>
              {busy === row.id ? "Working…" : actionLabel(action)}
            </Button>
          );
        }}
      />
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </>
  );
}
