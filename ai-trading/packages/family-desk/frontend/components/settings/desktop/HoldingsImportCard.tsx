"use client";

import { useEffect, useState } from "react";
import { useHoldings } from "@/components/shell/desktop/DeskContext";
import { Button } from "@/components/ui/Button";
import { ImportLine } from "@/components/fundamental/shared/ImportLine";
import { COPY } from "@/lib/desk/freshness";
import { runHoldingsImport } from "@/lib/desk/holdingsImport";
import { IMPORT_REREAD_DELAYS_MS, IMPORT_SOURCE_TEXT, lastImportText } from "@/lib/settings/fundamentalView";
import styles from "./settingsDesktop.module.css";

/** The Flex import (02n §c3 #4): its state, its source in words (never the token), and `Import now`. The statement arrives in the background, so the holdings are read again a few times afterwards. */
export function HoldingsImportCard({ disabled }: Readonly<{ disabled: boolean }>) {
  const { holdings, refresh } = useHoldings();
  // Which re-read comes next; null when no import was started from this card.
  const [attempt, setAttempt] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [starting, setStarting] = useState(false);

  const importState = holdings?.import.state;
  // After the first re-read, an import that is no longer running has finished.
  const settled = attempt !== null && attempt >= 1 && importState !== "running";
  const busy = starting || (attempt !== null && !settled) || importState === "running";

  useEffect(() => {
    if (attempt === null || settled) return;
    const timer = setTimeout(() => {
      refresh();
      setAttempt(attempt + 1 >= IMPORT_REREAD_DELAYS_MS.length ? null : attempt + 1);
    }, IMPORT_REREAD_DELAYS_MS[attempt]);
    return () => clearTimeout(timer);
  }, [attempt, settled, refresh]);

  async function importNow() {
    setStarting(true);
    setMessage(null);
    const result = await runHoldingsImport();
    setStarting(false);
    if (result.ok) {
      setMessage({ text: COPY.holdingsImporting, tone: "info" });
      setAttempt(0);
    } else {
      setMessage({ text: result.text, tone: "error" });
    }
  }

  return (
    <section className={styles.card} aria-labelledby="settings-holdings-import" data-testid="settings-holdings-import">
      <h2 id="settings-holdings-import" className={styles.eyebrow}>Holdings import</h2>
      {holdings === null ? (
        <p className={styles.helper}>Checking the holdings import…</p>
      ) : (
        <>
          <ImportLine state={holdings.import} linkSetup={false} />
          <ul className={styles.lines}>
            <li>Source: {IMPORT_SOURCE_TEXT}</li>
            <li>{lastImportText(holdings.import)}</li>
          </ul>
        </>
      )}
      <div className={styles.inline}>
        <Button
          data-testid="import-now"
          disabled={disabled || busy || holdings === null || importState === "not_configured"}
          onClick={() => void importNow()}
        >
          Import now
        </Button>
        {message && <span className={message.tone === "error" ? styles.errorText : styles.helper} role="status" data-testid="import-message">{message.text}</span>}
      </div>
    </section>
  );
}
