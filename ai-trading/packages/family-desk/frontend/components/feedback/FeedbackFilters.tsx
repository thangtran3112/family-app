"use client";

import { useEffect, useState } from "react";
import type { FeedbackKind } from "@/lib/feedback/schemas";
import { ChipToggleGroup } from "@/components/ui/ChipToggleGroup";
import { Segmented } from "@/components/ui/Segmented";
import {
  areaLabel,
  areaOptions,
  KIND_FILTER_LABEL,
  SORTS,
  STATUS_LABEL,
  STATUSES,
  toggleStatus,
  type FeedbackFilters as Filters,
} from "@/lib/desk/feedbackView";
import type { FeedbackItem } from "@/lib/feedback/schemas";
import styles from "./feedback.module.css";

const SEARCH_DELAY_MS = 300;

const KINDS: readonly { id: "" | FeedbackKind; label: string }[] = [
  { id: "", label: "All" },
  { id: "bug", label: KIND_FILTER_LABEL.bug },
  { id: "request", label: KIND_FILTER_LABEL.request },
];

/** Type, status chips, area, search and sort (02s §Frontend). `disabled` is the empty log: nothing to filter yet. */
export function FeedbackFilters({
  value,
  onChange,
  items,
  disabled,
}: {
  value: Filters;
  onChange: (next: Filters) => void;
  items: readonly Pick<FeedbackItem, "area">[];
  disabled: boolean;
}) {
  // The search applies a moment after she stops typing (or on Enter), so "volume" is one request and not six.
  const [text, setText] = useState(value.q);
  useEffect(() => {
    if (text.trim() === value.q.trim()) return;
    const timer = setTimeout(() => onChange({ ...value, q: text }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, value, onChange]);

  const areas = areaOptions(items, value.area);

  return (
    <div className={styles.filters}>
      <div className={styles.filterRow}>
        <Segmented
          label="Type"
          disabled={disabled}
          value={value.kind}
          options={KINDS.map((kind) => ({ value: kind.id, label: kind.label }))}
          onChange={(kind) => onChange({ ...value, kind })}
        />
        <ChipToggleGroup
          label="Status"
          disabled={disabled}
          options={STATUSES.map((status) => ({ id: status, label: STATUS_LABEL[status] }))}
          pressed={value.statuses}
          onToggle={(status) => onChange({ ...value, statuses: toggleStatus(value.statuses, status) })}
        />
      </div>
      <div className={styles.filterRow}>
        <select
          aria-label="Area"
          className={styles.area}
          value={value.area}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, area: event.target.value })}
        >
          <option value="">Area · All</option>
          {areas.map((area) => <option key={area} value={area}>Area · {areaLabel(area)}</option>)}
        </select>
        <div className={styles.search}>
          <svg className={styles.searchIcon} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
            <circle cx="6" cy="6" r="4.25" fill="none" stroke="var(--color-muted)" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M9.2 9.2L12.5 12.5" fill="none" stroke="var(--color-muted)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            className={styles.searchInput}
            aria-label="Search reports"
            placeholder="Search reports"
            autoComplete="off"
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onChange({ ...value, q: text });
            }}
          />
        </div>
        <span className={styles.spacer} />
        <span className={styles.sortLabel} id="feedback-sort-label">Sort</span>
        <Segmented
          labelledBy="feedback-sort-label"
          disabled={disabled}
          value={value.sort}
          options={SORTS.map((sort) => ({ value: sort.id, label: sort.label }))}
          onChange={(sort) => onChange({ ...value, sort })}
        />
      </div>
      {disabled && <p className={styles.reason}>Reason: filters turn on once there is a report to filter.</p>}
    </div>
  );
}
