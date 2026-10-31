"use client";

import { useState } from "react";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { areaLabel, formatShortDay, KIND_LABEL, reporterInitial, STATUS_LABEL, statusTone } from "@/lib/desk/feedbackView";
import type { FeedbackItem } from "@/lib/feedback/schemas";
import styles from "./feedback.module.css";

const COPIED_MS = 1500;

/** The Open and Copy id buttons a row shows on hover or keyboard focus (02s §Frontend); they sit over the end of the title, as on the board. */
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
    <span className={styles.hoverActions}>
      <button type="button" className={styles.miniButton} aria-label={`Open ${item.ref}`} onClick={() => onOpen(item.id)}>Open</button>
      <button type="button" className={styles.miniButton} aria-label={`Copy id ${item.ref}`} onClick={(event) => { event.stopPropagation(); void copy(); }}>{copied ? "Copied" : "Copy id"}</button>
    </span>
  );
}

/** The dense table of reports: 28 px rows, a 2 px amber edge on the selected row, hover on `--color-raised`. */
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
    { key: "id", label: "ID", render: (item) => <span className={styles.id}>{item.ref}</span> },
    { key: "type", label: "Type", render: (item) => <span className={styles.kind} data-kind={item.kind}>{KIND_LABEL[item.kind]}</span> },
    {
      key: "title",
      label: "Title",
      render: (item) => (
        <span className={styles.titleCell} data-selected={item.id === selectedId}>
          <span className={styles.titleText} title={item.title}>{item.title}</span>
          <RowActions item={item} onOpen={onSelect} />
        </span>
      ),
    },
    { key: "where", label: "Where", render: (item) => <span className={styles.where} title={item.route}>{item.route}</span> },
    { key: "area", label: "Area", render: (item) => <span className={`${styles.cell} ${styles.cellArea}`}>{areaLabel(item.area)}</span> },
    { key: "by", label: "Reported by", render: (item) => <span className={`${styles.cell} ${styles.cellBy}`}>{reporterInitial(item.reported_by)}</span> },
    { key: "updated", label: "Updated", render: (item) => <span className={styles.cellUpdated}>{formatShortDay(item.updated_at)}</span> },
    {
      key: "status",
      label: "Status",
      render: (item) => <span className={styles.status} data-tone={statusTone(item.status)}>{STATUS_LABEL[item.status]}</span>,
    },
  ];
  return (
    <div className={styles.tableWrap}>
      <DenseTable
        caption="Feedback reports"
        columns={columns}
        tight
        rows={items}
        rowKey={(item) => String(item.id)}
        selectedKey={selectedId === null ? null : String(selectedId)}
        onSelect={(item) => onSelect(item.id)}
      />
    </div>
  );
}
