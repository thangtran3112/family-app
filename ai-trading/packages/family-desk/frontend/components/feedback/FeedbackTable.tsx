"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { areaLabel, formatShortDay, KIND_LABEL, reporterInitial, STATUS_LABEL, statusTone } from "@/lib/desk/feedbackView";
import type { FeedbackItem } from "@/lib/feedback/schemas";

const COPIED_MS = 1500;

/** The Open and Copy id buttons a row shows on hover or keyboard focus; they stop propagation so the row is not selected. */
function RowActions({ item, onOpen }: { item: FeedbackItem; onOpen: (id: number) => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(item.ref);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // No clipboard permission: the id is on the row, so nothing is lost.
    }
  }
  return (
    <>
      <Button size="sm" aria-label={`Open ${item.ref}`} onClick={() => onOpen(item.id)}>Open</Button>
      <Button size="sm" variant="secondary" aria-label={`Copy id ${item.ref}`} onClick={(event) => { event.stopPropagation(); void copy(); }}>
        {copied ? "Copied" : "Copy id"}
      </Button>
    </>
  );
}

/** The dense table of reports: 28 px rows, a 2 px amber edge on the selected row, row actions revealed on hover and focus. */
export function FeedbackTable({
  items,
  selectedId,
  onSelect,
}: {
  items: readonly FeedbackItem[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const columns: DenseColumn<FeedbackItem>[] = [
    { key: "id", label: "ID", minWidth: 56, render: (item) => <span className="tabular-nums">{item.ref}</span> },
    { key: "type", label: "Type", render: (item) => <Badge tone="neutral">{KIND_LABEL[item.kind]}</Badge> },
    {
      key: "title",
      label: "Title",
      fill: true,
      truncate: true,
      render: (item) => item.title,
    },
    { key: "where", label: "Where", minWidth: 120, truncate: true, render: (item) => item.route },
    { key: "area", label: "Area", minWidth: 80, render: (item) => areaLabel(item.area) },
    { key: "by", label: "Reported by", minWidth: 90, render: (item) => reporterInitial(item.reported_by) },
    { key: "updated", label: "Updated", minWidth: 96, render: (item) => formatShortDay(item.updated_at) },
    {
      key: "status",
      label: "Status",
      minWidth: 90,
      render: (item) => <Badge tone={statusTone(item.status)}>{STATUS_LABEL[item.status]}</Badge>,
    },
  ];
  return (
    <DenseTable
      caption="Feedback reports"
      columns={columns}
      tight
      rows={items}
      rowKey={(item) => String(item.id)}
      selectedKey={selectedId === null ? null : String(selectedId)}
      onSelect={(item) => onSelect(item.id)}
      rowActions={(item) => <RowActions item={item} onOpen={onSelect} />}
      actions="hover"
      scrollX
    />
  );
}
