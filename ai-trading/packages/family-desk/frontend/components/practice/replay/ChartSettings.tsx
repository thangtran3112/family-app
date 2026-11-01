"use client";

import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Swatch } from "@/components/workspace/ChartLegend";
import { chartPalette } from "@/lib/desk/chartPalette";
import { OVERLAY_LOOK } from "@/lib/desk/workspace";
import { useDismiss } from "@/lib/desk/useDismiss";
import {
  CHART_TYPES,
  CHART_TYPE_LABELS,
  defaultChartPrefs,
  setChartType,
  togglePref,
  type ChartPrefs,
  type LevelId,
  type OverlayId,
} from "@/lib/replay/chartPrefs";
import styles from "./replay.module.css";

const OVERLAY_ROWS: ReadonlyArray<{ id: OverlayId; label: string; color: string; dashed?: boolean }> = [
  { id: "vwap", label: "VWAP", color: OVERLAY_LOOK.vwap.color },
  { id: "ema9", label: "EMA 9", color: OVERLAY_LOOK.ema9.color },
  { id: "ema21", label: "EMA 21", color: OVERLAY_LOOK.ema21.color, dashed: true },
  { id: "volume", label: "Volume", color: chartPalette.upHalf },
];

const LEVEL_ROWS: ReadonlyArray<{ id: LevelId; label: string }> = [
  { id: "prior_close", label: "Prior close" },
  { id: "session", label: "Session high and low" },
  { id: "opening_range", label: "Opening range (first 15 min)" },
];

export type ChartSettingsProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefs: ChartPrefs;
  onChange: (prefs: ChartPrefs) => void;
  /** The swing Daily view draws none of the intraday lines: those groups show, switched off, with the reason. */
  daily?: boolean;
};

/**
 * "Chart ▾" and its settings popover (design-replay-chart §b.1): the chart type, the overlays and the levels, applied as
 * they are picked. Native radios and checkboxes. The popover keeps every key that reaches it, so Space on a checkbox or
 * → on a radio does what the control does and never plays or steps the replay.
 */
export function ChartSettings({ open, onOpenChange, prefs, onChange, daily = false }: ChartSettingsProps) {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const noteId = useId();

  const close = (refocus: boolean) => {
    onOpenChange(false);
    if (refocus) button.current?.focus();
  };
  // A press outside closes it. Escape from elsewhere closes it too, and returns focus to the button only when focus was inside or nowhere.
  useDismiss(open, root, (via) => close(via === "escape" && (root.current?.contains(document.activeElement) === true || document.activeElement === document.body)));
  // Opened by the button or by C: focus lands on the checked type.
  useEffect(() => {
    if (open) popover.current?.querySelector<HTMLInputElement>('input[name="chart-type"]:checked')?.focus();
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") close(true);
    event.stopPropagation();
    // Next hydrates the whole document, so React's own key listener sits on `document`, the same node as the workspace's:
    // `stopPropagation` alone would not keep the key from it. React's listener was added first, so this reaches it before.
    event.nativeEvent.stopImmediatePropagation();
  };

  return (
    <div className={styles.chartMenu} ref={root}>
      <Button
        ref={button}
        size="md"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-keyshortcuts="C"
        title="Chart settings (C)"
        onClick={() => onOpenChange(!open)}
      >
        Chart <span aria-hidden="true">▾</span>
      </Button>
      {open && (
        <div id={popoverId} ref={popover} className={styles.chartPopover} role="dialog" aria-label="Chart settings" onKeyDown={onKeyDown}>
          <fieldset className={styles.setGroup}>
            <legend>Type</legend>
            <div className={styles.typeGroup}>
              {CHART_TYPES.map((type) => (
                <label key={type} className={styles.typeOption}>
                  <input type="radio" name="chart-type" value={type} checked={prefs.type === type} onChange={() => onChange(setChartType(prefs, type))} />
                  <span>{CHART_TYPE_LABELS[type]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.setGroup} disabled={daily} aria-describedby={daily ? noteId : undefined}>
            <legend>Overlays</legend>
            {OVERLAY_ROWS.map((row) => (
              <label key={row.id} className={styles.toggle}>
                <input type="checkbox" checked={prefs.on[row.id]} onChange={() => onChange(togglePref(prefs, row.id))} />
                <Swatch color={row.color} style={row.dashed ? "dashed" : "solid"} />
                <span>{row.label}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className={styles.setGroup} disabled={daily} aria-describedby={daily ? noteId : undefined}>
            <legend>Levels</legend>
            {LEVEL_ROWS.map((row) => (
              <label key={row.id} className={styles.toggle}>
                <input type="checkbox" checked={prefs.on[row.id]} onChange={() => onChange(togglePref(prefs, row.id))} />
                <span className={styles.dotted} aria-hidden="true" />
                <span>{row.label}</span>
              </label>
            ))}
          </fieldset>
          <p id={noteId} className={styles.footnote}>{daily ? "The daily view has no intraday lines." : "The practice stop and your marks always show."}</p>
          <div className={styles.settingsFoot}>
            <button type="button" className={styles.linkButton} onClick={() => onChange(defaultChartPrefs())}>Reset to defaults</button>
            <span className={styles.footnote}>Saved in this browser</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The Full screen button in the chart toolbar: a text button that keeps its label and shows the mode with `aria-pressed`. */
export function FullScreenButton({ full, onToggle }: { full: boolean; onToggle: () => void }) {
  return (
    <Button size="md" aria-pressed={full} aria-keyshortcuts="F" title="Full screen (F)" onClick={onToggle}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
        <path d="M1 4.5V1h3.5M7.5 1H11v3.5M11 7.5V11H7.5M4.5 11H1V7.5" />
      </svg>
      Full screen
    </Button>
  );
}
