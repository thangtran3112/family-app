"use client";

import { Suspense, useId, useState } from "react";
import type { ShellBand } from "@/lib/desk/viewport";
import { useDeskUi } from "./DeskContext";
import { FiltersPanel } from "./FiltersPanel";
import { WatchlistsPanel } from "./WatchlistsPanel";
import styles from "./leftrail.module.css";

type Tab = "watchlists" | "filters";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "watchlists", label: "Watchlists" },
  { id: "filters", label: "Filters" },
];

/** Left rail (02l §b2): her watchlists or saved filters, collapsible to a 48 px icon strip. */
export function LeftRail({ band }: { band: ShellBand }) {
  const { leftCollapsed, setLeftCollapsed } = useDeskUi();
  const [tab, setTab] = useState<Tab>("watchlists");
  const id = useId();

  if (leftCollapsed) {
    return (
      <aside aria-label="Watchlists and filters" className={styles.root}>
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
              {item.id === "watchlists" ? <ListIcon /> : <FilterIcon />}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  const panelId = `${id}-panel`;
  return (
    <aside aria-label="Watchlists and filters" className={styles.root}>
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
        {tab === "watchlists" ? (
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
