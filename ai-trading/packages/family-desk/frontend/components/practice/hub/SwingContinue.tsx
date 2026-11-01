"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { whenReady } from "@/lib/desk/patience";
import { continueOutcome } from "@/lib/replay/hubSwing";
import { problemMessage } from "@/lib/replay/setup";
import { continueSwingThread } from "@/lib/replay/swingApi";
import styles from "./hub.module.css";

/**
 * "Continue Day 7" of a swing thread (02p h): asks the server for the thread's current or next day and opens its board,
 * exactly as the day card does. While the thread's data is still being prepared it says so with the counts and stays on
 * the page; asking again later opens the day. Used by the hub card and the thread journal.
 */
export function SwingContinue({
  threadId,
  label,
  locked = false,
  onBusy,
  onChanged,
}: {
  threadId: number;
  label: string;
  /** Another thread's open is running: this button waits (the landing shares one flag across its rows). */
  locked?: boolean;
  onBusy?: (busy: boolean) => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [own, setOwn] = useState(false);
  const setBusy = (on: boolean) => {
    setOwn(on);
    onBusy?.(on);
  };
  const [waiting, setWaiting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The gateway cut the open short and the screen is asking again; the Desk is still preparing the day (D-058, D-066).
  const [still, setStill] = useState(false);

  async function open() {
    setBusy(true);
    setStill(false);
    setWaiting(null);
    setMessage(null);
    try {
      const outcome = continueOutcome(await whenReady(() => continueSwingThread(threadId), { onWaiting: () => setStill(true) }));
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
    } finally {
      setStill(false);
    }
  }

  return (
    <>
      <div className={styles.inline}>
        <Button variant="primary" disabled={locked || own} loading={locked || own} onClick={() => void open()}>{own ? PRACTICE_COPY.planOpening : label}</Button>
        {own && still && <p role="status" className={styles.hint}>{PRACTICE_COPY.planStillWorking}</p>}
        {waiting && (
          <p role="status" className={styles.hint}>
            {waiting} · {PRACTICE_COPY.swingPrepWaitHint}
          </p>
        )}
      </div>
      {message && <ErrorBlock message={message} onRetry={() => void open()} />}
    </>
  );
}
