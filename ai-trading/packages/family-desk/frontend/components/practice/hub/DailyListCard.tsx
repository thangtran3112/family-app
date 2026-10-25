"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadDaily, openNextDay } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { planCard } from "@/lib/replay/dayView";
import { problemMessage } from "@/lib/replay/setup";
import { DailyPlanForm } from "./DailyPlanForm";
import styles from "./hub.module.css";

const POLL_MS = 4000;

/** The hub's daily-list card (02o-b v1): "Day 7 of 20 · next: Tue" with Continue, the data-preparing line while the
 *  plan's bars are fetched, and the plan form. There is no block page: Continue opens the day. */
export function DailyListCard() {
  const router = useRouter();
  const daily = useDeskQuery("replay-daily", (signal) => loadDaily({ signal }));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const plan = daily.data?.plan ?? null;
  const preparing = plan?.prep.state === "running";
  const { refresh } = daily;
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [preparing, refresh]);

  async function open() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await openNextDay();
      if (result.day_list_id !== null) router.push(`/practice/day?id=${result.day_list_id}`);
      else {
        setBusy(false);
        refresh();
      }
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.planStartError));
      setBusy(false);
    }
  }

  if (daily.loading) return <LoadingBlock label="Loading your daily plan…" height={72} />;
  if (daily.data === null) return <ErrorBlock message={PRACTICE_COPY.loadError} onRetry={daily.refresh} />;

  if (plan === null || editing) {
    return (
      <DailyPlanForm
        onCancel={plan === null ? undefined : () => setEditing(false)}
        onSaved={(result) => {
          setEditing(false);
          if (result.day_list_id !== null) router.push(`/practice/day?id=${result.day_list_id}`);
          else refresh();
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
      {message && <p role="alert" className={styles.fieldError}>{message}</p>}
      <div className={styles.inline}>
        {(card.action === "continue" || card.action === "start") && (
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void open()}>
            {card.action === "start" ? PRACTICE_COPY.planStart : PRACTICE_COPY.planContinue}
          </button>
        )}
        <button type="button" className={styles.button} onClick={() => setEditing(true)}>{PRACTICE_COPY.planNew}</button>
      </div>
    </article>
  );
}
