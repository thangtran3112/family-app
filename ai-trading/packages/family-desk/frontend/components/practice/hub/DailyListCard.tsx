"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { whenReady } from "@/lib/desk/patience";
import { loadDaily, loadThreads, openNextDay } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { planArmedText, planCard } from "@/lib/replay/dayView";
import { problemMessage } from "@/lib/replay/setup";
import { DailyPlanForm } from "./DailyPlanForm";
import styles from "./hub.module.css";

const POLL_MS = 4000;

/** The hub's daily-list card (02o-b v1): "Day 7 of 20 · next: Tue" with Continue, the data-preparing line while the
 *  plan's bars are fetched, and the plan form. There is no block page: Continue opens the day. The thread card beside it
 *  reads the same plan, so every change here goes through `onChanged` and both refetch (D-046). */
export function DailyListCard({ revision, onChanged }: { revision?: number; onChanged: () => void }) {
  const router = useRouter();
  const daily = useDeskQuery("replay-daily", (signal) => loadDaily({ signal }), { revision });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Set while the gateway has cut a slow open short and the screen is asking again (D-058).
  const [still, setStill] = useState(false);

  const plan = daily.data?.plan ?? null;
  const thread = daily.data?.thread ?? null;
  // Only the empty state needs to know whether a swing thread exists (it changes the wording, not the rule).
  const needsThread = daily.data !== null && thread === null;
  const threads = useDeskQuery("replay-threads-for-daily", (signal) => loadThreads({ signal }), { revision, enabled: needsThread });
  const swingOnly = (threads.data ?? []).some((row) => row.thread.status === "active" && row.thread.mode === "swing");
  const preparing = plan?.prep.state === "running";
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(onChanged, POLL_MS);
    return () => clearInterval(timer);
  }, [preparing, onChanged]);

  async function open() {
    setBusy(true);
    setStill(false);
    setMessage(null);
    try {
      const result = await whenReady(() => openNextDay(), { onWaiting: () => setStill(true) });
      if (result.day_list_id !== null) router.push(`/practice/day?id=${result.day_list_id}`);
      else {
        setBusy(false);
        setStill(false);
        onChanged();
      }
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.planStartError));
      setStill(false);
      setBusy(false);
    }
  }

  if (daily.loading) return <LoadingBlock label="Loading your daily plan…" height={72} />;
  if (daily.data === null) return <ErrorBlock message={PRACTICE_COPY.loadError} onRetry={daily.refresh} />;

  if (plan === null || editing) {
    // The risk plan belongs to a practice thread (D-007): no thread, no daily plan form.
    if (thread === null) {
      return (
        <div className={styles.threadEmpty}>
          <p className={styles.muted}>{swingOnly ? PRACTICE_COPY.threadNeededDay : PRACTICE_COPY.threadNeeded}</p>
          {plan !== null && <button type="button" className={styles.button} onClick={() => setEditing(false)}>Cancel</button>}
        </div>
      );
    }
    return (
      <DailyPlanForm
        thread={thread.thread}
        onCancel={plan === null ? undefined : () => setEditing(false)}
        onSaved={(result) => {
          setEditing(false);
          if (result.day_list_id !== null) router.push(`/practice/day?id=${result.day_list_id}`);
          else onChanged();
        }}
      />
    );
  }

  const card = planCard(plan);
  return (
    <article className={styles.resume} aria-label="Daily list plan">
      <div className={styles.resumeHead}>
        <span className={styles.symbol}>{card.headline}</span>
        <span className={styles.muted}>{plan.filters.map((filter) => filter.name).join(" · ")}</span>
      </div>
      {card.detail && <p className={styles.muted}>{card.detail}</p>}
      <p className={styles.muted}>{planArmedText(plan)}</p>
      {still && <p role="status" className={styles.hint}>{PRACTICE_COPY.planStillWorking}</p>}
      {message && <ErrorBlock message={message} onRetry={() => void open()} />}
      <div className={styles.inline}>
        {(card.action === "continue" || card.action === "start") && (
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void open()}>
            {busy ? PRACTICE_COPY.planOpening : card.action === "start" ? PRACTICE_COPY.planStart : PRACTICE_COPY.planContinue}
          </button>
        )}
        <button type="button" className={styles.button} onClick={() => setEditing(true)}>{PRACTICE_COPY.planNew}</button>
      </div>
    </article>
  );
}
