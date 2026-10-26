"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { whenReady } from "@/lib/desk/patience";
import { openNextDay } from "@/lib/desk/replay";
import type { PracticePlan } from "@/lib/replay/daily";
import { planCard } from "@/lib/replay/dayView";
import { problemMessage } from "@/lib/replay/setup";
import { swingCardView } from "@/lib/replay/swing";
import type { ThreadSummary } from "@/lib/replay/threads";
import { SwingContinue } from "./SwingContinue";
import styles from "./hub.module.css";

/** True when the daily plan opens days in this thread: a plan bound to a closed thread, or to the swing thread, is not offered. */
export const planOpensIn = (plan: PracticePlan | null, thread: { id: number }): boolean =>
  plan !== null && !plan.finished && plan.thread_id === thread.id;

/**
 * What a thread can do next, for the landing's rows and the thread page (02r2): a day thread opens today's open day, or
 * the next day of its plan (`nextLabel`), or says a new plan is needed; a swing thread continues its day or opens its
 * finished week's review. A closed thread has no action. The same logic as the old thread card (D-046, D-048).
 */
export function ThreadAction({
  summary,
  plan,
  nextLabel = PRACTICE_COPY.planContinue,
  onChanged,
  onNewPlan,
}: {
  summary: ThreadSummary;
  plan: PracticePlan | null;
  nextLabel?: string;
  onChanged: () => void;
  onNewPlan?: () => void;
}) {
  const { thread, today } = summary;
  if (thread.status === "closed") return null;

  if (thread.mode === "swing") {
    const action = swingCardView(summary)?.action;
    if (!action || action.label === null) return null;
    if (action.kind === "review" && action.weekNo !== null) {
      return <Link href={`/practice/week?thread=${thread.id}&week=${action.weekNo}`} className={styles.primaryLink}>{action.label}</Link>;
    }
    return action.kind === "start" || action.kind === "continue" ? <SwingContinue threadId={thread.id} label={action.label} onChanged={onChanged} /> : null;
  }

  if (today !== null) return <Link href={`/practice/day?id=${today.day_list_id}`} className={styles.primaryLink}>{PRACTICE_COPY.planContinue}</Link>;
  if (!planOpensIn(plan, thread)) {
    return onNewPlan ? (
      <button type="button" className={styles.button} onClick={onNewPlan}>{PRACTICE_COPY.landingNeedsPlan}</button>
    ) : (
      <p className={styles.muted}>{PRACTICE_COPY.landingNeedsPlan}</p>
    );
  }
  // The plan's data is still being prepared: the first list opens when it is ready.
  const card = planCard(plan);
  if (card.action === "none") return <p role="status" className={styles.muted}>{card.headline}</p>;
  return <OpenNextDay label={card.action === "start" ? PRACTICE_COPY.planStart : nextLabel} onChanged={onChanged} />;
}

/** Opens the plan's next day and goes to it; with the data not ready yet the answer has no day and the screen refetches. */
function OpenNextDay({ label, onChanged }: { label: string; onChanged: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Set while the gateway has cut a slow open short and the screen is asking again (D-058).
  const [still, setStill] = useState(false);

  async function open() {
    setBusy(true);
    setStill(false);
    setMessage(null);
    try {
      const result = await whenReady(() => openNextDay(), { onWaiting: () => setStill(true) });
      if (result.day_list_id !== null) {
        router.push(`/practice/day?id=${result.day_list_id}`);
        return;
      }
      setBusy(false);
      setStill(false);
      onChanged();
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.threadResumeError));
      setStill(false);
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={styles.primary} disabled={busy} aria-busy={busy || undefined} onClick={() => void open()}>
        {busy ? PRACTICE_COPY.planOpening : label}
      </button>
      {still && <p role="status" className={styles.hint}>{PRACTICE_COPY.planStillWorking}</p>}
      {message && <ErrorBlock message={message} onRetry={() => void open()} />}
    </>
  );
}
