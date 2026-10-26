"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { formatEtTimeZone } from "@/lib/desk/format";
import { loadDayList, startDaySession } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { namesTodayText, stripRows } from "@/lib/replay/dayView";
import { problemMessage } from "@/lib/replay/setup";
import styles from "./panels.module.css";

/** The day's names beside the chart (02o-b2): the names she has opened and the ones she starred. Switching opens a name
 *  at the shared day clock, or resumes it; the server says in plain words when a trade is still open or the plan's
 *  name limit is reached. Reads the day list, so it shows the cap and who is behind the clock. */
export function DayNames({ dayListId, current, playhead, revision }: { dayListId: number; current: string; playhead: string; revision: number }) {
  const router = useRouter();
  const list = useDeskQuery(`day-names:${dayListId}`, (signal) => loadDayList(dayListId, {}, { signal }), { revision });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (list.data === null) {
    return list.error === null ? null : <p className={styles.muted}>{PRACTICE_COPY.dayLoadError}</p>;
  }
  const day = list.data;
  const rows = stripRows(day, { symbol: current, playhead });
  const ended = day.status === "ended";

  async function switchTo(symbol: string) {
    setBusy(symbol);
    setMessage(null);
    try {
      const session = await startDaySession(dayListId, symbol);
      router.push(`/practice/replay?id=${session.id}`);
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.dayStartError));
    } finally {
      setBusy(null); // the workspace stays mounted across the switch, so the buttons must come back
    }
  }

  return (
    <div className={styles.dayNames}>
      <p className={styles.muted}>{namesTodayText(day)}</p>
      {rows.length === 0 ? (
        <p className={styles.muted}>{PRACTICE_COPY.dayStripNone}</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((row) => (
            <li key={row.symbol} className={styles.row} data-symbol={row.symbol}>
              <span className={styles.armedName}>{row.symbol}</span>
              {row.holding && <span className={styles.chip} data-tone="down">{PRACTICE_COPY.dayHolding}</span>}
              {row.behind && <span className={styles.chip}>{PRACTICE_COPY.dayBehind}</span>}
              {row.symbol === current ? (
                <span className={styles.detail}>{PRACTICE_COPY.dayOnNow}</span>
              ) : (
                !ended && (
                  <button
                    type="button"
                    className={styles.switchButton}
                    disabled={busy !== null}
                    aria-label={practiceText("daySwitch", { symbol: row.symbol })}
                    onClick={() => void switchTo(row.symbol)}
                  >
                    Switch
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      {message && <p className={styles.problem} role="alert">{message}</p>}
      {!ended && day.clock && <p className={styles.muted}>{practiceText("daySwitchHint", { time: formatEtTimeZone(day.clock) })}</p>}
    </div>
  );
}
