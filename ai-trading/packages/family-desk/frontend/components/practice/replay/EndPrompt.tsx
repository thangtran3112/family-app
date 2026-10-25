"use client";

import { useState } from "react";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { sessionOverText } from "@/lib/replay/journalView";
import styles from "./panels.module.css";

// Ending the session (02o §a3). At the window end it says so and offers "End and score". Before that it is a quiet
// button that asks first: ending early shows the rest of the day in the journal.

export type EndPromptProps = { tradeCount: number; atEnd: boolean; busy: boolean; onEnd: () => void };

export function EndPrompt({ tradeCount, atEnd, busy, onEnd }: EndPromptProps) {
  const [confirming, setConfirming] = useState(false);

  if (atEnd) {
    // "Session over · 3 practice trades · See journal": the last part is a pointer, so it reads as muted text.
    const [, lead = "", tail] = /^(.*?)(?: · (See journal))?$/.exec(sessionOverText(tradeCount)) ?? [];
    return (
      <div className={styles.endBlock}>
        <p className={styles.endText}>
          {lead}
          {tail && <> · <span className={styles.muted}>{tail}</span></>}
        </p>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={onEnd}>
          {PRACTICE_COPY.endAndScore}
        </button>
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className={styles.endBlock}>
        <button type="button" className={`${styles.button} ${styles.quiet}`} disabled={busy} onClick={() => setConfirming(true)}>
          End session…
        </button>
      </div>
    );
  }

  return (
    <div role="group" aria-label="Confirm ending the session" className={styles.confirm}>
      <p className={styles.endText}>{PRACTICE_COPY.endEarlyWarning}</p>
      <div className={styles.confirmActions}>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={onEnd}>
          {PRACTICE_COPY.endAndScore}
        </button>
        <button type="button" className={styles.button} onClick={() => setConfirming(false)}>
          Keep practising
        </button>
      </div>
    </div>
  );
}
