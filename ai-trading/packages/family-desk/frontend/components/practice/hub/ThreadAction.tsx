"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type MouseEvent } from "react";
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

/** Props that switch a link off while an open runs: a link has no `disabled`, so it is greyed, skipped by Tab and not followed. */
export const lockLink = (locked: boolean) =>
  locked ? { "aria-disabled": true as const, tabIndex: -1, onClick: (event: MouseEvent) => event.preventDefault() } : {};

/**
 * What a thread can do next, for the landing's rows and the thread page (02r2): a day thread resumes today's open day,
 * or opens the next day of its plan ("Start day" for the first), or says a new plan is needed; a swing thread continues
 * its day or opens its finished week's review. A closed thread has no action. The same logic as the old thread card
 * (D-046, D-048). `busy` is true while any thread's open runs, so no second open can race the first; `onBusy` reports
 * this action's own open.
 */
export function ThreadAction({
  summary,
  plan,
  busy = false,
  onBusy,
  onChanged,
  onNewPlan,
}: {
  summary: ThreadSummary;
  plan: PracticePlan | null;
  busy?: boolean;
  onBusy?: (busy: boolean) => void;
  onChanged: () => void;
  onNewPlan?: () => void;
}) {
  const { thread, today } = summary;
  if (thread.status === "closed") return null;

  if (thread.mode === "swing") {
    const action = swingCardView(summary)?.action;
    if (!action || action.label === null) return null;
    if (action.kind === "review" && action.weekNo !== null) {
      return <Link href={`/practice/week?thread=${thread.id}&week=${action.weekNo}`} className={styles.primaryLink} {...lockLink(busy)}>{action.label}</Link>;
    }
    return action.kind === "start" || action.kind === "continue" ? <SwingContinue threadId={thread.id} label={action.label} locked={busy} onBusy={onBusy} onChanged={onChanged} /> : null;
  }

  if (today !== null) return <Link href={`/practice/day?id=${today.day_list_id}`} className={styles.primaryLink} {...lockLink(busy)}>{PRACTICE_COPY.planResume}</Link>;
  if (!planOpensIn(plan, thread)) {
    return onNewPlan ? (
      <button type="button" className={styles.button} disabled={busy} aria-busy={busy || undefined} onClick={onNewPlan}>{PRACTICE_COPY.landingNeedsPlan}</button>
    ) : (
      <p className={styles.muted}>{PRACTICE_COPY.landingNeedsPlan}</p>
    );
  }
  // The plan's data is still being prepared: the first list opens when it is ready.
  const card = planCard(plan);
  if (card.action === "none") return <p role="status" className={styles.muted}>{card.headline}</p>;
  return <OpenNextDay label={card.action === "start" ? PRACTICE_COPY.planStart : PRACTICE_COPY.planResume} locked={busy} onBusy={onBusy} onChanged={onChanged} />;
}

/** Opens the plan's next day and goes to it; with the data not ready yet the answer has no day and the screen refetches. */
function OpenNextDay({ label, locked, onBusy, onChanged }: { label: string; locked: boolean; onBusy?: (busy: boolean) => void; onChanged: () => void }) {
  const router = useRouter();
  const [own, setOwn] = useState(false);
  const setBusy = (on: boolean) => {
    setOwn(on);
    onBusy?.(on);
  };
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
      <button type="button" className={styles.primary} disabled={locked || own} aria-busy={locked || own || undefined} onClick={() => void open()}>
        {own ? PRACTICE_COPY.planOpening : label}
      </button>
      {still && <p role="status" className={styles.hint}>{PRACTICE_COPY.planStillWorking}</p>}
      {message && <ErrorBlock message={message} onRetry={() => void open()} />}
    </>
  );
}
