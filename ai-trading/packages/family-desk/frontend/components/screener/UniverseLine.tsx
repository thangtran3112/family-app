"use client";

import { loadUniverse } from "@/lib/desk/screener";
import { universeDetails, universeLine } from "@/lib/desk/screenerView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "./screener.module.css";

/** "Scanned 131 US stocks and ETFs · as of last close Fri 2026-10-23", with the build details one click away. */
export function UniverseLine() {
  const universe = useDeskQuery("screener-universe", (signal) => loadUniverse({ signal }));
  if (universe.data === null) {
    return <p className={styles.muted}>{universe.error === null ? "Checking what was scanned…" : "Scan details unavailable right now"}</p>;
  }
  return (
    <div className={styles.universe}>
      <p>{universeLine(universe.data)}</p>
      <details>
        <summary>Details</summary>
        <ul>
          {universeDetails(universe.data).map((line) => <li key={line}>{line}</li>)}
        </ul>
      </details>
    </div>
  );
}
