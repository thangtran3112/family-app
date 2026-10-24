"use client";

import styles from "./editor.module.css";

export function JsonPanel({ spec }: { spec: Record<string, unknown> }) {
  const text = JSON.stringify(spec, null, 2);
  return (
    <details className={styles.panel}>
      <summary className={styles.summary}>View JSON</summary>
      <div className={styles.jsonBody}>
        <button type="button" className={styles.button} onClick={() => void navigator.clipboard?.writeText(text).catch(() => undefined)}>Copy</button>
        <pre className={styles.pre}>{text}</pre>
      </div>
    </details>
  );
}
