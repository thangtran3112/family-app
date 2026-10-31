"use client";

import { useEffect, useRef } from "react";
import styles from "./builder.module.css";

/** A developer view of the stored spec. Escape or a click outside closes it (V-Strategies-06). */
export function JsonView({ spec }: { spec: unknown }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function close(event: Event) {
      const details = ref.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        details.querySelector("summary")?.focus();
      } else if (details.contains(event.target as Node)) return;
      details.open = false;
    }
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, []);

  return (
    <details className={styles.jsonView} ref={ref}>
      <summary>Developer view (JSON)</summary>
      <pre aria-label="Stored strategy specification JSON">{JSON.stringify(spec, null, 2)}</pre>
    </details>
  );
}
