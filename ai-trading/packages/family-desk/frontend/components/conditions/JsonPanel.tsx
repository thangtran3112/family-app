"use client";

import { Button } from "@/components/ui/Button";
import styles from "./conditions.module.css";

export function JsonPanel({ spec }: { spec: Record<string, unknown> }) {
  const text = JSON.stringify(spec, null, 2);
  return (
    <details className={styles.panel}>
      <summary className={styles.summary}>View JSON</summary>
      <div className={styles.jsonBody}>
        <Button onClick={() => void navigator.clipboard?.writeText(text).catch(() => undefined)}>Copy</Button>
        <pre className={styles.pre}>{text}</pre>
      </div>
    </details>
  );
}
