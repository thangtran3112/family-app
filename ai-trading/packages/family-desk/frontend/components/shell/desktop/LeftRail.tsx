"use client";

import { Suspense, useId, useState } from "react";
import { HoldingsRailPanel } from "@/components/fundamental/rail/HoldingsRailPanel";
import type { ShellBand } from "@/lib/desk/viewport";
import { useDeskUi } from "./DeskContext";
import { FiltersPanel } from "./FiltersPanel";
import { WatchlistsPanel } from "./WatchlistsPanel";
import styles from "./leftrail.module.css";

type Tab = "holdings" | "watchlists" | "filters";

const TECHNICAL_TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "watchlists", label: "Watchlists" },
  { id: "filters", label: "Filters" },
];
// The Fundamental lane swaps Filters for her holdings (02n §b1); the Watchlists tab is the same panel.
const FUNDAMENTAL_TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "holdings", label: "Holdings" },
  { id: "watchlists", label: "Watchlists" },
];

/** Left rail (02l §b2, 02n §b1): her watchlists and saved filters, or in the Fundamental lane her holdings and watchlists; collapsible to a 48 px icon strip. */
export function LeftRail({ band }: { band: ShellBand }) {
  const { lane, leftCollapsed, setLeftCollapsed } = useDeskUi();
  const TABS = lane === "fundamental" ? FUNDAMENTAL_TABS : TECHNICAL_TABS;
  const [chosen, setTab] = useState<Tab | null>(null);
  // No tab picked yet, or one the other lane owned (Filters, Holdings): the lane's first tab.
  const tab = TABS.find((item) => item.id === chosen)?.id ?? TABS[0]!.id;
  const label = lane === "fundamental" ? "Holdings and watchlists" : "Watchlists and filters";
  const id = useId();

  if (leftCollapsed) {
    return (
      <aside aria-label={label} className={styles.root}>
        <div className={styles.strip}>
          <button type="button" className={styles.iconButton} aria-label="Expand left panel" onClick={() => setLeftCollapsed(false)}>
            <ChevronIcon direction="right" />
          </button>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.iconButton}
              aria-label={item.label}
              title={item.label}
              onClick={() => {
                setTab(item.id);
                setLeftCollapsed(false);
              }}
            >
              {item.id === "filters" ? <FilterIcon /> : <ListIcon />}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  const panelId = `${id}-panel`;
  return (
    <aside aria-label={label} className={styles.root}>
      <div className={styles.header}>
        <div role="tablist" aria-label="Left panel" className={styles.tabs}>
          {TABS.map((item) => (
            <button
              key={item.id}
              id={`${id}-${item.id}`}
              type="button"
              role="tab"
              className={styles.tab}
              aria-selected={tab === item.id}
              aria-controls={panelId}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className={styles.iconButton} aria-label="Collapse left panel" onClick={() => setLeftCollapsed(true)}>
          <ChevronIcon direction="left" />
        </button>
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={`${id}-${tab}`} className={styles.panel}>
        {tab === "holdings" ? (
          <HoldingsRailPanel band={band} />
        ) : tab === "watchlists" ? (
          <WatchlistsPanel band={band} />
        ) : (
          // useSearchParams needs a Suspense boundary for static prerendering (Next.js docs).
          <Suspense fallback={null}>
            <FiltersPanel />
          </Suspense>
        )}
      </div>
    </aside>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={direction === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6 4h8M6 8h8M6 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 3.5h11L9 8.5v4l-2 1v-5z" />
    </svg>
  );
}
