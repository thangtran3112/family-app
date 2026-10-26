"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { ThreadStrip } from "@/components/practice/thread/ThreadStrip";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { createReplaySession, loadReplayFeed, loadReplaySession, patchReplaySession } from "@/lib/desk/replay";
import { formatEtDay } from "@/lib/desk/format";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { adherenceHint, journalDatesHidden, noTradesText, signalRows, summaryTiles, swingJournalDay, tradeRows } from "@/lib/replay/journalView";
import { isSwingSession } from "@/lib/replay/playView";
import type { ReplaySession } from "@/lib/replay/schemas";
import { problemMessage } from "@/lib/replay/setup";
import { isSwingDayList, loadAnyDayList } from "@/lib/replay/swingApi";
import { AdherenceChecklist } from "./AdherenceChecklist";
import { JournalChart } from "./JournalChart";
import { NotesAndRating } from "./NotesAndRating";
import { SignalsVsTradesTable } from "./SignalsVsTradesTable";
import { SummaryTiles } from "./SummaryTiles";
import { TradesTable } from "./TradesTable";
import styles from "./journal.module.css";

/** `/practice/journal?id=`: the scored session (02o §a4). Reads the URL, so the page wraps it in Suspense. */
export function JournalScreen() {
  const raw = useSearchParams().get("id");
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const session = useDeskQuery(`replay-session:${id}`, (signal) => loadReplaySession(id ?? 0, { signal }), { enabled: id !== null });

  if (id === null) {
    return (
      <div className={styles.center}>
        <EmptyBlock title="No practice session selected"><Link href="/practice" className={styles.link}>Open Practice</Link></EmptyBlock>
      </div>
    );
  }
  if (session.data === null) {
    return (
      <div className={styles.center}>
        {session.error === null ? <LoadingBlock label="Loading the journal…" height={320} /> : <ErrorBlock message={PRACTICE_COPY.loadError} onRetry={session.refresh} />}
      </div>
    );
  }
  return <Journal key={session.data.id} session={session.data} onSaved={session.refresh} />;
}

function Journal({ session, onSaved }: { session: ReplaySession; onSaved: () => void }) {
  const router = useRouter();
  const { spec, journal } = session;
  const ended = session.status === "ended";
  // The date stays masked while the session is open, and for a swing session while its thread goes on (one date names every later day).
  const hidden = journalDatesHidden(session);
  const swing = isSwingSession(session);
  const swingDay = useDeskQuery(`journal-swing-day:${session.day_list_id}`, (signal) => loadAnyDayList(session.day_list_id ?? 0, {}, { signal }), {
    enabled: hidden && swing && session.day_list_id !== null,
  });
  const feed = useDeskQuery(`replay-feed:${session.id}:${session.status}`, (signal) => loadReplayFeed(session.id, { interval: spec.interval }, { signal }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [again, setAgain] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });

  useReportPracticeChrome({ day: spec.day, hidden, playhead: ended ? session.window_end : session.revealed_through });

  const save = (patch: { notes?: string | null; rating?: number | null }) => {
    setSaving(true);
    setSaved(false);
    patchReplaySession(session.id, patch)
      .then(() => {
        setSaved(true);
        onSaved();
      })
      .catch(() => setAgain((current) => ({ ...current, message: PRACTICE_COPY.markError })))
      .finally(() => setSaving(false));
  };

  // Same setup, new attempt: the server numbers it.
  const replayAgain = () => {
    setAgain({ busy: true, message: null });
    createReplaySession(spec)
      .then((next) => router.push(`/practice/replay?id=${next.id}`))
      .catch((error: unknown) => setAgain({ busy: false, message: problemMessage(error, PRACTICE_COPY.startError) }));
  };

  const swingList = swingDay.data !== null && isSwingDayList(swingDay.data) ? swingDay.data : null;
  const dayLabel = hidden ? (swing ? swingJournalDay(swingList) : PRACTICE_COPY.hiddenDay) : formatEtDay(spec.day);
  const tiles = summaryTiles(journal);
  const signalCount = feed.data?.signals.length ?? 0;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>{spec.symbol} · {dayLabel} · attempt {session.attempt} · Practice journal</h1>
        <div className={styles.actions}>
          {!ended && <Link href={`/practice/replay?id=${session.id}`} className={`${styles.button} ${styles.primary}`}>Resume</Link>}
        </div>
      </header>
      {session.thread && <ThreadStrip thread={session.thread} />}
      <div className={styles.center}>
        {!ended && <p className={styles.banner} role="status">{PRACTICE_COPY.sessionOpen} · totals are live and the rest of the day stays hidden</p>}
        {ended && journal.totals.trades === 0 && <p className={styles.muted} role="status">{noTradesText(signalCount)}</p>}
        <SummaryTiles tiles={tiles} hint={adherenceHint(journal)} />
        <section className={styles.section} aria-label="Chart">
          <h2 className={styles.sectionTitle}>Chart</h2>
          {feed.data ? (
            <JournalChart session={session} feed={feed.data} hideDates={hidden} />
          ) : feed.error === null ? (
            <LoadingBlock label="Loading the chart…" height={320} />
          ) : (
            <ErrorBlock subject="chart" onRetry={feed.refresh} />
          )}
        </section>
        <section className={styles.section} aria-label="Trades">
          <h2 className={styles.sectionTitle}>Trades</h2>
          <TradesTable rows={tradeRows(journal.trades)} />
        </section>
        <section className={styles.section} aria-label="Signals versus your trades">
          <h2 className={styles.sectionTitle}>Signals versus your trades</h2>
          <SignalsVsTradesTable
            rows={signalRows(journal.signals_vs_trades)}
            empty={ended ? "No signals fired in this window" : "Signals and what came after them appear when you end the session"}
          />
        </section>
      </div>
      <RightRail
        label="Journal details"
        sections={[
          {
            id: "adherence",
            label: "Adherence",
            node: (
              <div className={styles.rail}>
                <AdherenceChecklist adherence={journal.adherence} />
                <NotesAndRating notes={session.notes} rating={session.rating} saving={saving} saved={saved} onSave={save} />
                <div className={styles.actions}>
                  {session.day_list_id === null ? (
                    <button type="button" className={`${styles.button} ${styles.primary}`} disabled={again.busy} onClick={replayAgain}>Replay this day again</button>
                  ) : (
                    <Link href={`/practice/day?id=${session.day_list_id}`} className={`${styles.button} ${styles.primary}`}>{PRACTICE_COPY.backToList}</Link>
                  )}
                  <Link href="/practice" className={styles.button}>New session</Link>
                </div>
                {again.message && <p className={styles.muted} role="alert">{again.message}</p>}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
