"use client";

import { useEffect, useRef, useState } from "react";
import { Segmented } from "@/components/ui/Segmented";
import { CHART_TIMEFRAMES } from "@/lib/desk/timeframes";
import { useDismiss } from "@/lib/desk/useDismiss";
import { INDICATOR_OPTIONS, type IndicatorId } from "@/lib/desk/workspace";
import styles from "./workspaceHeader.module.css";

const SESSIONS = [
  { value: "regular", label: "Regular" },
  { value: "extended", label: "Extended" },
] as const;

const GROUPS = ["Overlays", "Panes"] as const;

export type ChartToolbarProps = {
  timeframe: string;
  onTimeframe: (api: string) => void;
  session: "regular" | "extended";
  onSession: (session: "regular" | "extended") => void;
  indicators: ReadonlySet<IndicatorId>;
  onToggleIndicator: (id: IndicatorId) => void;
  alertHref: string;
};

/** Timeframe, session, Indicators menu, and + Alert (02l §b2, §b5). */
export function ChartToolbar({ timeframe, onTimeframe, session, onSession, indicators, onToggleIndicator, alertHref }: ChartToolbarProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useDismiss(open, wrapRef, (via) => {
    setOpen(false);
    if (via === "escape") buttonRef.current?.focus();
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.code !== "KeyA") return;
      if (event.target instanceof Element && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
      event.preventDefault();
      window.location.assign(alertHref);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [alertHref]);

  return (
    <div className={styles.toolbar}>
      <div role="group" aria-label="Timeframe" className={styles.group}>
        {CHART_TIMEFRAMES.map((option) => (
          <button
            key={option.api}
            type="button"
            className={styles.timeframe}
            aria-pressed={option.api === timeframe}
            onClick={() => onTimeframe(option.api)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <Segmented label="Session" size="lg" value={session} options={SESSIONS} onChange={onSession} className={styles.session} />
      <div className={styles.menuAnchor} ref={wrapRef}>
        <button
          ref={buttonRef}
          type="button"
          className={styles.menuButton}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Indicators
        </button>
        {open && (
          <div role="menu" aria-label="Indicators" className={styles.popover}>
            {GROUPS.map((group) => (
              <div key={group} role="group" aria-label={group}>
                <div className={styles.groupLabel}>{group}</div>
                {INDICATOR_OPTIONS.filter((option) => option.group === group).map((option) => {
                  const checked = indicators.has(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      className={styles.menuItem}
                      onClick={() => onToggleIndicator(option.id)}
                    >
                      <span aria-hidden="true" className={styles.tick}>{checked ? "✓" : ""}</span>
                      {option.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      <a href={alertHref} className={styles.alert} title="New alert · Alt+A" aria-keyshortcuts="Alt+A">
        + Alert
      </a>
    </div>
  );
}
