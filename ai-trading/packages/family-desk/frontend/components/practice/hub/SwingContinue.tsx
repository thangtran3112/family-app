"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { continueOutcome } from "@/lib/replay/hubSwing";
import { problemMessage } from "@/lib/replay/setup";
import { continueSwingThread } from "@/lib/replay/swingApi";
import styles from "./hub.module.css";

/**
 * "Continue Day 7" of a swing thread (02p h): asks the server for the thread's current or next day and opens its board,
 * exactly as the day card does. While the thread's data is still being prepared it says so with the counts and stays on
 * the page; asking again later opens the day. Used by the hub card and the thread journal.
 */
export function SwingContinue({ threadId, label, onChanged }: { threadId: number; label: string; onChanged: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setWaiting(null);
    setMessage(null);
    try {
      const outcome = continueOutcome(await continueSwingThread(threadId));
      if (outcome.kind === "open") {
        router.push(`/practice/day?id=${outcome.dayListId}`);
        return;
      }
      if (outcome.kind === "preparing") setWaiting(outcome.text);
      else onChanged();
      setBusy(false);
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.swingContinueError));
      setBusy(false);
    }
  }

  return (
    <>
      <div className={styles.inline}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void open()}>{label}</button>
        {waiting && (
          <p role="status" className={styles.hint}>
            {waiting} · {PRACTICE_COPY.swingPrepWaitHint}
          </p>
        )}
      </div>
      {message && <p role="alert" className={styles.fieldError}>{message}</p>}
    </>
  );
}
