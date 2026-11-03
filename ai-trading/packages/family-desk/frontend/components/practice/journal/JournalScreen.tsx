"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { PracticeTabs } from "@/components/practice/hub/PracticeTabs";
import { ThreadStrip } from "@/components/practice/thread/ThreadStrip";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { Button } from "@/components/ui/Button";
import { PracticeNotice } from "@/components/practice/PracticeNotice";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadReplayFeed, loadReplaySession, patchReplaySession } from "@/lib/desk/replay";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { adherenceHint, noTradesText, signalRows, summaryTiles, tradeRows } from "@/lib/replay/journalView";
import { replayHref, screenHref } from "@/lib/replay/practiceTabs";
import type { ReplaySession } from "@/lib/replay/schemas";
import { routeId } from "@/lib/replay/routeId";
import { AdherenceChecklist } from "./AdherenceChecklist";
import { JournalChart } from "./JournalChart";
import { NotesAndRating } from "./NotesAndRating";
import { SignalsVsTradesTable } from "./SignalsVsTradesTable";
import { SummaryTiles } from "./SummaryTiles";
import { TradesTable } from "./TradesTable";
import styles from "./journal.module.css";

/**
 * `/practice/journal?id=`: one lane's journal (02o §a4; ADR-0025). A lane is a name's book for the life of its thread, so its journal is read live and is
 * never final: totals follow the thread clock and nothing after it is shown. There is no ending it and no replaying it; the chart and the Screen are
 * one click away. Reads the URL, so the page wraps it in Suspense.
 */
export function JournalScreen() {
  const { id } = routeId(useSearchParams().get("id"));
  const session = useDeskQuery(`replay-session:${id}`, (signal) => loadReplaySession(id ?? 0, { signal }), { enabled: id !== null });

  // The route only opens this screen when `?id=` is there, so an id with no number is one she gave that names nothing: not found (D-193).
  if (id === null) {
    return (
      <div className={styles.center}>
        <PracticeNotice title={PRACTICE_COPY.sessionNotFound} />
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
  const { spec, journal } = session;
  // A lane is live. Only a legacy standalone row is `ended`: it is read-only and has no chart to open.
  const live = session.status === "active";
  const threadId = session.thread?.id ?? session.thread_id;
  const feed = useDeskQuery(`replay-feed:${session.id}:${session.status}`, (signal) => loadReplayFeed(session.id, { interval: spec.interval }, { signal }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The journal reads live and belongs to no single day: the band says "past days", with no replay time of its own.
  useReportPracticeChrome({ day: null, playhead: null, scope: "days" });

  const save = (patch: { notes?: string | null; rating?: number | null }) => {
    setSaving(true);
    setSaved(false);
    setMessage(null);
    patchReplaySession(session.id, patch)
      .then(() => {
        setSaved(true);
        onSaved();
      })
      .catch(() => setMessage(PRACTICE_COPY.notesError))
      .finally(() => setSaving(false));
  };

  const tiles = summaryTiles(journal);
  const signalCount = feed.data?.signals.length ?? 0;

  return (
    <div className={styles.screen}>
      {session.thread && <PracticeTabs threadId={session.thread.id} active="journal" />}
      <header className={styles.header}>
        <h1 className={styles.title}>{spec.symbol} · Practice journal</h1>
        <div className={styles.actions}>
          {live && <Button client href={replayHref(session.id)} variant="primary">{PRACTICE_COPY.journalOpenChart}</Button>}
        </div>
      </header>
      {session.thread && <ThreadStrip thread={session.thread} />}
      <div className={styles.center}>
        {live && <p className={styles.banner} role="status">{PRACTICE_COPY.journalLaneLive}</p>}
        {journal.totals.trades === 0 && <p className={styles.muted} role="status">{noTradesText(signalCount)}</p>}
        <SummaryTiles tiles={tiles} hint={adherenceHint(journal)} />
        <section className={styles.section} aria-label="Chart">
          <h2 className={styles.sectionTitle}>Chart</h2>
          {feed.data ? (
            <JournalChart session={session} feed={feed.data} />
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
          <SignalsVsTradesTable rows={signalRows(journal.signals_vs_trades)} empty={PRACTICE_COPY.journalNoSignals} />
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
                  {threadId === null ? (
                    <Button client href="/practice" variant="primary">{PRACTICE_COPY.openPractice}</Button>
                  ) : (
                    <Button client href={screenHref(threadId)} variant="primary">{PRACTICE_COPY.journalOpenScreen}</Button>
                  )}
                </div>
                {message && <p className={styles.muted} role="alert">{message}</p>}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
