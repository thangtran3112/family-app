"use client";

import type { ScreenerResults } from "@/lib/api/schemas";
import { loadUniverse } from "@/lib/desk/screener";
import { scanLine, universeDetails } from "@/lib/desk/screenerView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "./screener.module.css";

/** "Scanned 131 symbols at 3:45 PM ET Fri 2026-10-23" from the run on screen, with how the universe is built one
 * click away. The count is the run's own, so it always covers the match count beside it (V-SCR-02). */
export function UniverseLine({ run }: { run: ScreenerResults | null }) {
  const universe = useDeskQuery("screener-universe", (signal) => loadUniverse({ signal }));
  if (run === null && universe.data === null) return null;
  return (
    <div className={styles.universe}>
      {run && <p>{scanLine(run)}</p>}
      {universe.data && (
        <details>
          <summary>Details</summary>
          <ul>
            {universeDetails(universe.data).map((line) => <li key={line}>{line}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
