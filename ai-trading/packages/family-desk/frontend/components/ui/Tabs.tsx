"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { rovingStop, rovingTarget, tabDomIds } from "@/lib/desk/primitivesView";
import styles from "./Tabs.module.css";

export type TabItem<T extends string> = { id: T; label: ReactNode };

/**
 * Tabs switch what is shown below them: a `tablist` with one roving stop. The arrows move to the next tab and select it (they wrap),
 * Home and End jump, Tab leaves the list once. The selected tab is a 2 px amber underline. Give `idBase` and wrap the content in a
 * `TabPanel` with the same base so the tab names its panel (`aria-controls`) and the panel its tab. Use `Segmented` to pick a value
 * and `ChipToggleGroup` for filters that combine.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idBase,
  panelMounted = true,
  track = true,
  size = "lg",
  className,
}: {
  tabs: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  /** The list's name for assistive tech. */
  label: string;
  idBase: string;
  /** False while the selected tab's panel is not rendered (a collapsed drawer), so `aria-controls` never points at nothing. */
  panelMounted?: boolean;
  /** Draw the hairline the underline sits on. Off when the surrounding bar already has one. */
  track?: boolean;
  /** md 28 px (a panel header), lg 32 px (a screen). */
  size?: "md" | "lg";
  /** Layout only (grid-area, margin, padding); never colour, size or type. */
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = tabs.findIndex((tab) => tab.id === value);
  const stop = rovingStop(selected, tabs.map(() => true));

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = rovingTarget(event.key, index, tabs.length, { axis: "horizontal" });
    const tab = next === null ? undefined : tabs[next];
    if (tab === undefined) return;
    event.preventDefault();
    refs.current[next as number]?.focus();
    onChange(tab.id);
  }

  return (
    <div role="tablist" aria-label={label} className={`${styles.root} ${className ?? ""}`} data-size={size} data-track={track}>
      {tabs.map((tab, index) => {
        const ids = tabDomIds(idBase, tab.id);
        const active = index === selected;
        return (
          <button
            key={tab.id}
            ref={(element) => { refs.current[index] = element; }}
            id={ids.tab}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={active && panelMounted ? ids.panel : undefined}
            tabIndex={index === stop ? 0 : -1}
            className={styles.tab}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** The content of the selected tab. Same `idBase` and `id` as the `Tabs` it belongs to. */
export function TabPanel({ idBase, id, children, className }: { idBase: string; id: string; children: ReactNode; className?: string }) {
  const ids = tabDomIds(idBase, id);
  return <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} className={className}>{children}</div>;
}
