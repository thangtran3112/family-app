"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
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
  /** A day's open practice trades, named: ending the day exits them at the price on screen. Null with none open. */
  exits?: string | null;
};

export function EndPrompt({ tradeCount, atEnd, busy, onEnd, day = false, swing, exits = null }: EndPromptProps) {
  const asDay = day || swing !== undefined;
  const endLabel = asDay ? PRACTICE_COPY.dayEnd : PRACTICE_COPY.endAndScore;
  const warning = swing ? endDayPrompt({ dayNo: swing.dayNo, clock: swing.clock, holdsOpen: swing.holdsOpen }) : day ? PRACTICE_COPY.dayEndWarning : PRACTICE_COPY.endEarlyWarning;
  const hint = swing ? endDayHint(swing.holdsOpen) : null;
  const [confirming, setConfirming] = useState(false);
  const endRef = useRef<HTMLButtonElement>(null);

  if (atEnd && swing) {
    // At the close: just the day, the holds note and the button.
    return (
      <div className={styles.endBlock}>
        <p className={styles.endText}>
          End Day {swing.dayNo}
          {hint && <> · <span className={styles.muted}>{hint}</span></>}
        </p>
        <Button size="md" variant="primary" disabled={busy} onClick={onEnd}>
          {endLabel}
        </Button>
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
        <Button size="md" variant="primary" disabled={busy} onClick={onEnd}>
          {endLabel}
        </Button>
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className={styles.endBlock}>
        <Button ref={endRef} size="md" disabled={busy} onClick={() => setConfirming(true)}>
          {asDay ? "End day…" : "End session…"}
        </Button>
        {hint && <span className={styles.muted}>{hint}</span>}
      </div>
    );
  }

  return (
    <div className={styles.endSlot}>
      <InlineConfirm
        label={asDay ? "Confirm ending the day" : "Confirm ending the session"}
        layout="floating"
        size="md"
        className={styles.endAnchor}
        prompt={
          <>
            <span>{warning}</span>
            {exits && <span>{exits}</span>}
          </>
        }
        confirmLabel={endLabel}
        cancelLabel="Keep practicing"
        busy={busy}
        returnFocus={endRef}
        onConfirm={onEnd}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
