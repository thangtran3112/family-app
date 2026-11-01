"use client";

import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { ScreenerFilter } from "@/lib/api/schemas";
import { EMPTY_VALUE } from "@/lib/desk/format";
import { COPY } from "@/lib/desk/freshness";
import { loadFilters } from "@/lib/desk/screener";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { useDeskUi } from "./DeskContext";
import styles from "./leftrail.module.css";

function FilterRow({ filter, active }: { filter: ScreenerFilter; active: boolean }) {
  return (
    <li>
      <a href={`/screener?filter=${filter.id}`} className={styles.filterRow} aria-current={active ? "page" : undefined}>
        {filter.read_only && (
          <>
            <span className={styles.lock}><Icon name="lock" size={12} /></span>
            <span className="sr-only">Read-only</span>
          </>
        )}
        <span className={styles.filterName}>{filter.name}</span>
        <span className={styles.count}>{filter.last_run?.matches_total ?? EMPTY_VALUE}</span>
      </a>
    </li>
  );
}

export function FiltersPanel() {
  const { revisions } = useDeskUi();
  const filters = useDeskQuery("rail-filters", (signal) => loadFilters({ signal }), { revision: revisions.filters });
  const current = useSearchParams().get("filter");

  if (filters.data === null) {
    return filters.error === null ? <LoadingBlock label="Loading filters…" /> : <ErrorBlock subject="filter list" onRetry={filters.refresh} />;
  }

  const defaults = filters.data.filter((filter) => filter.read_only);
  const mine = filters.data.filter((filter) => !filter.read_only);
  return (
    <div className={styles.filters}>
      <section aria-labelledby="filters-defaults">
        <h2 id="filters-defaults" className={styles.groupTitle}>Defaults</h2>
        <ul className={styles.list}>
          {defaults.map((filter) => (
            <FilterRow key={filter.id} filter={filter} active={String(filter.id) === current} />
          ))}
        </ul>
      </section>
      <section aria-labelledby="filters-mine">
        <h2 id="filters-mine" className={styles.groupTitle}>My filters</h2>
        {mine.length === 0 ? (
          <p className={styles.muted}>No saved filters yet</p>
        ) : (
          <ul className={styles.list}>
            {mine.map((filter) => (
              <FilterRow key={filter.id} filter={filter} active={String(filter.id) === current} />
            ))}
          </ul>
        )}
        <a href="/screener/filters" className={styles.filterRow}>{COPY.newFilter}</a>
      </section>
    </div>
  );
}
