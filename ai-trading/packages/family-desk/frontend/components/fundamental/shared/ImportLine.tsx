import type { ImportState } from "@/lib/api/fundamentalSchemas";
import { importLine } from "@/lib/desk/fundamentalView";
import styles from "../fundamental.module.css";
import { ImportText } from "./ImportText";

/** "Holdings as of Fri 2026-10-23 close · IBKR Flex · 21 lots", or why there is nothing to show. */
/** `linkSetup` is off on the Settings page itself, where a link to Settings would point at the page the user is on. */
export function ImportLine({ state, linkSetup = true }: { state: ImportState; linkSetup?: boolean }) {
  const line = importLine(state);
  return (
    <p className={styles.importLine} data-tone={line.tone} role="status" data-testid="import-line">
      <span className={styles.importDot} aria-hidden="true" />
      <span>{linkSetup ? <ImportText text={line.text} /> : line.text}</span>
    </p>
  );
}
