import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import type { ScreenerFilter } from "@/lib/api/schemas";
import { COPY } from "@/lib/desk/freshness";
import styles from "./screener.module.css";

/** The default filters and hers as chips above the header (D5): one click runs a filter, the last chip starts a new one. */
export function FilterChips({ filters, activeId }: { filters: readonly ScreenerFilter[]; activeId: number | null }) {
  return (
    <nav aria-label="Screener filters">
      <ul className={styles.chips}>
        {filters.map((filter) => (
          <li key={filter.id}>
            <Button href={`/screener?filter=${filter.id}`} size="md" aria-current={filter.id === activeId ? "page" : undefined}>
              {filter.read_only && <Icon name="lock" size={12} />}
              {filter.name}
              {filter.read_only && <span className="sr-only"> Read-only</span>}
            </Button>
          </li>
        ))}
        <li>
          <Button href="/screener/filters" size="md" variant="primary">{COPY.newFilter}</Button>
        </li>
      </ul>
    </nav>
  );
}
