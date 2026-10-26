"use client";

import { useEffect, useState } from "react";
import type { FeedbackKind } from "@/lib/feedback/schemas";
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
        <div role="radiogroup" aria-label="Type" className={styles.segmented} data-tone="amber">
          {KINDS.map((kind) => (
            <button
              key={kind.id || "all"}
              type="button"
              role="radio"
              aria-checked={value.kind === kind.id}
              disabled={disabled}
              className={styles.seg}
              onClick={() => onChange({ ...value, kind: kind.id })}
            >
              {kind.label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Status" className={styles.chips}>
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              aria-pressed={value.statuses.includes(status)}
              disabled={disabled}
              className={styles.chip}
              onClick={() => onChange({ ...value, statuses: toggleStatus(value.statuses, status) })}
            >
              {STATUS_LABEL[status]}
            </button>
          ))}
        </div>
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
        <div role="radiogroup" aria-labelledby="feedback-sort-label" className={styles.segmented}>
          {SORTS.map((sort) => (
            <button
              key={sort.id}
              type="button"
              role="radio"
              aria-checked={value.sort === sort.id}
              disabled={disabled}
              className={styles.seg}
              onClick={() => onChange({ ...value, sort: sort.id })}
            >
              {sort.label}
            </button>
          ))}
        </div>
      </div>
      {disabled && <p className={styles.reason}>Reason: filters turn on once there is a report to filter.</p>}
    </div>
  );
}
