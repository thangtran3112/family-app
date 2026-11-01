"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { sessionOverText } from "@/lib/replay/journalView";
import { endDayHint, endDayPrompt } from "@/lib/replay/swing";
import styles from "./replay.module.css";

// The foot of the replay workspace (02o §a3): Back to the day list and the end control side by side, one width and one
// height, so they line up on both edges. At the window end the end control says so and offers "End and score"; before that
// it is a button that asks first, because ending early shows the rest of the day in the journal.

export type EndPromptProps = {
  tradeCount: number;
  atEnd: boolean;
  busy: boolean;
  onEnd: () => void;
  /** A daily-list session ends with its day: the same prompt, worded for the day. */
  day?: boolean;
  /** A swing day (02p a2 step 4a): open holds stay open overnight, so the prompt says so, and there is no score to point at. */
  swing?: { dayNo: number; /** The day clock (ISO). */ clock: string | null; holdsOpen: number };
  /** A day's open practice trades, named: ending the day exits them at the price you see now. Null with none open. */
  exits?: string | null;
  /** The day list this session belongs to; its Back link sits on the left of the row. Null for a standalone session. */
  backHref?: string | null;
  /** The session is over: the row shows how it ended, and a standalone session points at its journal. */
  ended?: { swing: boolean; journalHref: string } | null;
};

export function EndPrompt({ tradeCount, atEnd, busy, onEnd, day = false, swing, exits = null, backHref = null, ended = null }: EndPromptProps) {
  const asDay = day || swing !== undefined;
  const endLabel = asDay ? PRACTICE_COPY.dayEnd : PRACTICE_COPY.endAndScore;
  const warning = swing ? endDayPrompt({ dayNo: swing.dayNo, clock: swing.clock, holdsOpen: swing.holdsOpen }) : day ? PRACTICE_COPY.dayEndWarning : PRACTICE_COPY.endEarlyWarning;
  const hint = swing ? endDayHint(swing.holdsOpen) : null;
  const [confirming, setConfirming] = useState(false);
  const endRef = useRef<HTMLButtonElement>(null);

  // What the row says above its buttons, in one muted line.
  let note: string | null = null;
  if (ended) note = ended.swing ? `${PRACTICE_COPY.swingDayOver} · ${PRACTICE_COPY.swingScoredWeekly}` : sessionOverText(tradeCount);
  else if (atEnd && swing) note = hint ? `End Day ${swing.dayNo} · ${hint}` : `End Day ${swing.dayNo}`;
  else if (atEnd) note = sessionOverText(tradeCount);
  else if (hint) note = hint;

  return (
    <div className={styles.endBar}>
      {note && <p className={styles.endNote}>{note}</p>}
      <div className={styles.endRow}>
        {backHref ? (
          <Button href={backHref} client size="touch">
            <Icon name="chevron-left" />
            {PRACTICE_COPY.backToList}
          </Button>
        ) : (
          <span />
        )}
        <div className={styles.endCell}>
          {ended ? (
            ended.swing ? null : <Button href={ended.journalHref} size="touch">Open the journal</Button>
          ) : confirming ? (
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
          ) : atEnd ? (
            <Button ref={endRef} size="touch" variant="primary" disabled={busy} onClick={onEnd}>{endLabel}</Button>
          ) : (
            <Button ref={endRef} size="touch" disabled={busy} onClick={() => setConfirming(true)}>{asDay ? "End day…" : "End session…"}</Button>
          )}
        </div>
      </div>
    </div>
  );
}
