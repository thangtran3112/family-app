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
            <a href={`/screener?filter=${filter.id}`} className={styles.chip} aria-current={filter.id === activeId ? "page" : undefined}>
              {filter.read_only && (
                <svg className={styles.lock} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                  <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
                  <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
                </svg>
              )}
              {filter.name}
              {filter.read_only && <span className={styles.srOnly}> Read-only</span>}
            </a>
          </li>
        ))}
        <li>
          <a href="/screener/filters" className={`${styles.chip} ${styles.chipNew}`}>{COPY.newFilter}</a>
        </li>
      </ul>
    </nav>
  );
}
