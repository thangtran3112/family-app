"use client";

import { useState } from "react";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { sessionOverText } from "@/lib/replay/journalView";
import { endDayHint, endDayPrompt } from "@/lib/replay/swing";
import styles from "./panels.module.css";

// Ending the session (02o §a3). At the window end it says so and offers "End and score". Before that it is a quiet
// button that asks first: ending early shows the rest of the day in the journal.

export type EndPromptProps = {
  tradeCount: number;
  atEnd: boolean;
  busy: boolean;
  onEnd: () => void;
  /** A daily-list session ends with its day: the same prompt, worded for the day. */
  day?: boolean;
  /** A swing day (02p a2 step 4a): open holds stay open overnight, so the prompt says so, and there is no score to point at. */
  swing?: { dayNo: number; /** The day clock (ISO). */ clock: string | null; holdsOpen: number };
};

export function EndPrompt({ tradeCount, atEnd, busy, onEnd, day = false, swing }: EndPromptProps) {
  const asDay = day || swing !== undefined;
  const endLabel = asDay ? PRACTICE_COPY.dayEnd : PRACTICE_COPY.endAndScore;
  const warning = swing ? endDayPrompt({ dayNo: swing.dayNo, clock: swing.clock, holdsOpen: swing.holdsOpen }) : day ? PRACTICE_COPY.dayEndWarning : PRACTICE_COPY.endEarlyWarning;
  const hint = swing ? endDayHint(swing.holdsOpen) : null;
  const [confirming, setConfirming] = useState(false);

  if (atEnd && swing) {
    // At the close: just the day, the holds note and the button.
    return (
      <div className={styles.endBlock}>
        <p className={styles.endText}>
          End Day {swing.dayNo}
          {hint && <> · <span className={styles.muted}>{hint}</span></>}
        </p>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={onEnd}>
          {endLabel}
        </button>
      </div>
    );
  }

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
          {endLabel}
        </button>
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className={styles.endBlock}>
        <button type="button" className={`${styles.button} ${styles.quiet}`} disabled={busy} onClick={() => setConfirming(true)}>
          {asDay ? "End day…" : "End session…"}
        </button>
        {hint && <span className={styles.muted}>{hint}</span>}
      </div>
    );
  }

  return (
    <div role="group" aria-label={asDay ? "Confirm ending the day" : "Confirm ending the session"} className={styles.confirm}>
      <p className={styles.endText}>{warning}</p>
      <div className={styles.confirmActions}>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={onEnd}>
          {endLabel}
        </button>
        <button type="button" className={styles.button} onClick={() => setConfirming(false)}>
          Keep practising
        </button>
      </div>
    </div>
  );
}
