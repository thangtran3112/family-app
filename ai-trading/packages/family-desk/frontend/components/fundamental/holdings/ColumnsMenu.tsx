"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { metricLabel, ALL_METRICS } from "@/lib/desk/metricColumns";
import { MAX_COLUMNS, type MetricKey } from "@/lib/settings/fundamental";
import styles from "./holdings.module.css";

export type ColumnsSaveStatus = "idle" | "saving" | "saved" | "error";

/** The `Columns` menu (02n §b2): up to eight metric columns, saved in `settings.fundamental_columns`. */
export function ColumnsMenu({
  chosen,
  disabled,
  status,
  onChange,
  onRetry,
}: {
  chosen: readonly MetricKey[];
  disabled: boolean;
  status: ColumnsSaveStatus;
  onChange: (next: MetricKey[]) => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const full = chosen.length >= MAX_COLUMNS;
  return (
    <div className={styles.menuWrap} ref={wrap}>
      <Button size="md" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} data-testid="fund-columns">
        Columns · {chosen.length}
      </Button>
      {open && (
        <div id={id} className={styles.menu} role="group" aria-label="Columns">
          <p className={styles.menuNote}>Choose up to {MAX_COLUMNS} columns</p>
          {ALL_METRICS.map((key) => {
            const checked = chosen.includes(key);
            const blocked = disabled || (!checked && full);
            return (
              <label key={key} className={styles.option} data-disabled={blocked}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={blocked}
                  onChange={() => onChange(checked ? chosen.filter((item) => item !== key) : [...chosen, key])}
                />
                {metricLabel(key)}
              </label>
            );
          })}
          <p className={`${styles.status} ${status === "error" ? styles.statusProblem : ""}`} role="status">
            {status === "saving" && "Saving…"}
            {status === "saved" && "Saved"}
            {status === "error" && (
              <>
                Columns were not saved ·{" "}
                <Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
