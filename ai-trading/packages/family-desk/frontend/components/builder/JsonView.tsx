"use client";

import styles from "./builder.module.css";

export function JsonView({ spec }: { spec: unknown }) {
  return (
    <details className={styles.jsonView}>
      <summary>View JSON</summary>
      <pre aria-label="Stored strategy specification JSON">{JSON.stringify(spec, null, 2)}</pre>
    </details>
  );
}
