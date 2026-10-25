"use client";

import Link from "next/link";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { formatEtDay, formatEtTimeZone } from "@/lib/desk/format";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { formatUsd, moneyTone } from "@/lib/replay/journalView";
import type { ReplaySessionSummary } from "@/lib/replay/schemas";
import styles from "./hub.module.css";

/** The active practice session, if any: where the playhead is and her practice P/L, with a Resume link. */
export function ResumeCard({
  session,
  loading,
  error,
  onRetry,
}: {
  session: ReplaySessionSummary | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (error !== null) return <ErrorBlock message={PRACTICE_COPY.loadError} onRetry={onRetry} />;
  if (loading) return <LoadingBlock label="Loading practice sessions…" height={96} />;
  if (session === null) return <EmptyBlock title="No active practice session" />;

  return (
    <article className={styles.resume} aria-label="Active practice session">
      <div className={styles.resumeHead}>
        <span className={styles.symbol}>{session.symbol}</span>
        <span className={styles.muted}>{session.hide_date === "yes" ? PRACTICE_COPY.hiddenDay : formatEtDay(session.day)}</span>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt className={styles.muted}>Playhead</dt>
          <dd>{formatEtTimeZone(session.revealed_through)}</dd>
        </div>
        <div>
          <dt className={styles.muted}>Practice P/L</dt>
          <dd className={styles[moneyTone(session.pnl_usd)]}>{formatUsd(session.pnl_usd)}</dd>
        </div>
      </dl>
      <Link href={`/practice/replay?id=${session.id}`} className={styles.primaryLink}>Resume</Link>
    </article>
  );
}
