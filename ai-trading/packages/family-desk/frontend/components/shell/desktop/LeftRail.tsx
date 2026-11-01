"use client";

import { Suspense, useId, useState } from "react";
import { HoldingsRailPanel } from "@/components/fundamental/rail/HoldingsRailPanel";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import type { ShellBand } from "@/lib/desk/viewport";
import { LEFT_RAIL_TABS, type LeftRailTab } from "@/lib/lanes";
import { useDeskUi } from "./DeskContext";
import { FiltersPanel } from "./FiltersPanel";
import { WatchlistsPanel } from "./WatchlistsPanel";
import styles from "./leftrail.module.css";

type Tab = LeftRailTab;

const TAB_LABEL: Record<Tab, string> = { holdings: "Holdings", watchlists: "Watchlists", filters: "Filters" };

/** Left rail (02l §b2, 02n §b1): the mode's tabs from `LEFT_RAIL_TABS` (ADR-0014), collapsible to a 48 px icon strip. */
export function LeftRail({ band }: { band: ShellBand }) {
  const { lane, leftCollapsed, setLeftCollapsed } = useDeskUi();
  const TABS = LEFT_RAIL_TABS[lane].map((id) => ({ id, label: TAB_LABEL[id] }));
  const [chosen, setTab] = useState<Tab | null>(null);
  // No tab picked yet, or one another mode owned (Filters, Holdings): the mode's first tab.
  const tab = TABS.find((item) => item.id === chosen)?.id ?? TABS[0]!.id;
  // "Watchlists and filters", "Holdings and watchlists", "Watchlists".
  const label = TABS.map((item, index) => (index === 0 ? item.label : item.label.toLowerCase())).join(" and ");
  const id = useId();

  if (leftCollapsed) {
    return (
      <aside aria-label={label} className={styles.root}>
        <div className={styles.strip}>
          <Button variant="ghost" size="md" iconOnly aria-label="Expand left panel" onClick={() => setLeftCollapsed(false)}>
            <Icon name="chevron-right" />
          </Button>
          {TABS.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              size="md"
              iconOnly
              aria-label={item.label}
              title={item.label}
              onClick={() => {
                setTab(item.id);
                setLeftCollapsed(false);
              }}
            >
              <Icon name={item.id === "filters" ? "filter" : "list"} />
            </Button>
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
        <Button variant="ghost" size="md" iconOnly aria-label="Collapse left panel" onClick={() => setLeftCollapsed(true)}>
          <Icon name="chevron-left" />
        </Button>
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
