import type { ImportState } from "@/lib/api/fundamentalSchemas";
import { importLine } from "@/lib/desk/fundamentalView";
import styles from "../fundamental.module.css";

/** "Holdings as of Fri 2026-10-23 close · IBKR Flex · 21 lots", or why there is nothing to show. */
export function ImportLine({ state }: { state: ImportState }) {
  const line = importLine(state);
  return (
    <p className={styles.importLine} data-tone={line.tone} role="status" data-testid="import-line">
      <span className={styles.importDot} aria-hidden="true" />
      <span>{line.text}</span>
    </p>
  );
}
