"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { AdherenceChecklist } from "@/components/practice/journal/AdherenceChecklist";
import { NotesAndRating } from "@/components/practice/journal/NotesAndRating";
import { ThreadTiles } from "@/components/practice/journal/thread/ThreadTiles";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { whenReady } from "@/lib/desk/patience";
import { continueSwingThread, patchWeek, type WeekOut } from "@/lib/replay/swingApi";
import { problemMessage } from "@/lib/replay/setup";
import type { Thread } from "@/lib/replay/threads";
import {
  WEEK_TEXT,
  linkDayRows,
  startOutcome,
  threadHref,
  threadOverviewHref,
  universeLines,
  weekAction,
  weekSubtitle,
  weekTitle,
} from "@/lib/replay/weekScreen";
import {
  filterQualityLine,
  focusUntradedLines,
  heatStrip,
  sourceQualityLine,
  weekDayRows,
  weekEquitySeries,
  weekHeading,
  weekHoldRows,
  weekSelectionText,
  weekTiles,
} from "@/lib/replay/weekView";
import { DaysTable } from "./DaysTable";
import { EquityPanes } from "./EquityPanes";
import { UniverseHeatStrip } from "./UniverseHeatStrip";
import { WeekHoldsTable } from "./WeekHoldsTable";
import styles from "./week.module.css";

type Marks = { notes: string | null; rating: number | null };
type SaveState = { saving: boolean; saved: boolean; error: string | null };

/**
 * `/practice/week?thread=&week=`: one week of a swing thread (02p e1), frozen at the week's last close, or "Week to date"
 * for the open week. Every dollar is SIMULATED. `thread` is null until the thread loads (or if it did not): the review is
 * complete without it, only the day links and the Start Week button need it.
 */
export function WeekReview({ threadId, week, thread }: { threadId: number; week: WeekOut; thread: Thread | null }) {
  const router = useRouter();
  const { review } = week;
  const toDate = week.to_date === "yes";
  const heading = weekHeading(week, review.holds.filter((hold) => hold.status === "open").length);

  const tiles = useMemo(() => weekTiles(review, toDate), [review, toDate]);
  const series = useMemo(() => weekEquitySeries(review), [review]);
  const dayRows = useMemo(() => linkDayRows(weekDayRows(review), thread?.daily), [review, thread]);
  const holdRows = useMemo(() => weekHoldRows(review), [review]);
  const heat = useMemo(() => heatStrip(review), [review]);
  const adherence = useMemo(
    () => ({ ...review.adherence, score_pct: review.adherence.score_pct === null ? null : Math.round(review.adherence.score_pct) }),
    [review.adherence],
  );
  const bySource = sourceQualityLine(review.source_quality);
  const sourceLine = bySource === null ? null : `${WEEK_TEXT.sourceLead} · ${bySource}`;
  const filterLine = filterQualityLine(review.filter_quality);
  const untraded = focusUntradedLines(review.focus_untraded);
  const universe = universeLines(week.universe_label);
  const action = weekAction({ weekNo: week.week_no, toDate, lastDayNo: review.week.last_day_no, state: thread?.swing, daily: thread?.daily, today: thread?.today });

  // The rating shows the moment she picks it and goes back, with a line saying so, if the save fails. The notes stay in the
  // box she typed them in until the server has them, so a failed save loses no text. `confirmed` is the last value the
  // server returned; the newest answer wins.
  const [marks, setMarks] = useState<Marks>({ notes: week.notes, rating: week.rating });
  const [save, setSave] = useState<SaveState>({ saving: false, saved: false, error: null });
  const confirmed = useRef<Marks>(marks);
  const newest = useRef(0);
  const applied = useRef(0);
  const saveMarks = (patch: { notes?: string | null; rating?: number | null }) => {
    const mine = ++newest.current;
    if (patch.rating !== undefined) setMarks((current) => ({ ...current, rating: patch.rating ?? null }));
    setSave({ saving: true, saved: false, error: null });
    patchWeek(threadId, week.week_no, patch)
      .then((out) => {
        if (mine < applied.current) return;
        applied.current = mine;
        confirmed.current = { notes: out.notes, rating: out.rating };
        setMarks(confirmed.current);
        if (mine === newest.current) setSave({ saving: false, saved: true, error: null });
      })
      .catch((error: unknown) => {
        if (mine !== newest.current) return;
        setMarks(confirmed.current);
        setSave({ saving: false, saved: false, error: problemMessage(error, WEEK_TEXT.saveError) });
      });
  };

  const [start, setStart] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const startWeek = () => {
    setStart({ busy: true, message: null });
    whenReady(() => continueSwingThread(threadId))
      .then((next) => {
        const outcome = startOutcome(next);
        if (outcome.kind === "open") router.push(outcome.href);
        else setStart({ busy: false, message: outcome.text });
      })
      .catch((error: unknown) => setStart({ busy: false, message: problemMessage(error, PRACTICE_COPY.swingContinueError) }));
  };

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <Link href={threadOverviewHref(threadId)} className={styles.link}>{WEEK_TEXT.back}</Link>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{weekTitle(week)}</h1>
            <Badge tone={toDate ? "warn" : "neutral"}>{heading.badge}</Badge>
            <SimulatedBadge />
          </div>
          <p className={styles.sub}>{weekSubtitle(week)}</p>
          {heading.note !== null && <p className={styles.sub}>{heading.note}</p>}
          <p className={styles.sub}>{universe.lead}</p>
          {universe.rest !== null && (
            <details className={styles.details}>
              <summary className={styles.summary}>{WEEK_TEXT.universeMore}</summary>
              <p className={styles.hint}>{universe.rest}</p>
            </details>
          )}
        </div>
        {/* The way on sits beside the "Final" chip, not 1,770 px down under the tables and the notes (D-088). A final week's one way on is the ← Thread link. */}
        <div className={styles.actions}>
          <Link href={threadHref(threadId)} className={styles.link}>{WEEK_TEXT.threadJournal}</Link>
          {action.kind === "start" ? (
            <Button variant="primary" disabled={start.busy} onClick={startWeek}>{action.label}</Button>
          ) : (
            action.href !== null && <Button client href={action.href} variant="primary">{action.label}</Button>
          )}
        </div>
      </header>
      {start.message !== null && <p className={`${styles.alert} ${styles.alertBar}`} role="alert">{start.message}</p>}

      <div className={styles.center}>
        <section className={styles.section} aria-labelledby="week-summary-title">
          <div className={styles.sectionHead}>
            <h2 id="week-summary-title" className={styles.sectionTitle}>{WEEK_TEXT.summaryTitle}</h2>
            <SimulatedBadge />
          </div>
          <ThreadTiles tiles={tiles} fourAcross />
          <p className={styles.lead}>{weekSelectionText(review)}</p>
        </section>

        <section className={styles.section} aria-labelledby="week-equity-title">
          <div className={styles.sectionHead}>
            <h2 id="week-equity-title" className={styles.sectionTitle}>{PRACTICE_COPY.swingEquityTitle}</h2>
            <SimulatedBadge />
          </div>
          <EquityPanes series={series} />
        </section>

        <section className={styles.section} aria-labelledby="week-days-title">
          <div className={styles.sectionHead}>
            <h2 id="week-days-title" className={styles.sectionTitle}>{PRACTICE_COPY.swingDaysTitle}</h2>
            <SimulatedBadge />
          </div>
          <DaysTable rows={dayRows} />
        </section>

        <section className={styles.section} aria-labelledby="week-holds-title">
          <div className={styles.sectionHead}>
            <h2 id="week-holds-title" className={styles.sectionTitle}>{PRACTICE_COPY.swingHoldsTitle}</h2>
            <SimulatedBadge />
          </div>
          <WeekHoldsTable rows={holdRows} />
        </section>

        <section className={styles.section} aria-labelledby="week-heat-title">
          <h2 id="week-heat-title" className={styles.sectionTitle}>{PRACTICE_COPY.swingHeatTitle}</h2>
          <p className={styles.hint}>{PRACTICE_COPY.swingHeatHint}</p>
          <UniverseHeatStrip items={heat} label={WEEK_TEXT.heatLabel} />
          {(sourceLine !== null || filterLine !== null) && (
            <ul className={styles.lines} role="list">
              {sourceLine !== null && <li>{sourceLine}</li>}
              {filterLine !== null && <li>{filterLine}</li>}
            </ul>
          )}
          {untraded.length > 0 && (
            <>
              <h3 className={styles.subTitle}>{PRACTICE_COPY.swingFocusTitle}</h3>
              <ul className={styles.lines} role="list">
                {untraded.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </>
          )}
        </section>

        <div className={styles.pair}>
          <section className={styles.block} aria-labelledby="week-adherence-title">
            <h2 id="week-adherence-title" className={styles.sectionTitle}>{PRACTICE_COPY.swingAdherenceTitle}</h2>
            <p className={styles.hint}>{PRACTICE_COPY.swingScoredWeekly}</p>
            <AdherenceChecklist adherence={adherence} empty="No plan rule applies to this week" />
          </section>
          <section className={styles.block} aria-labelledby="week-notes-title">
            <h2 id="week-notes-title" className={styles.sectionTitle}>{WEEK_TEXT.notesTitle}</h2>
            <NotesAndRating
              notes={marks.notes}
              rating={marks.rating}
              saving={save.saving}
              saved={save.saved}
              onSave={saveMarks}
              notesLabel={PRACTICE_COPY.swingWeekNotes}
            />
            {save.error !== null && <p className={styles.alert} role="alert">{save.error}</p>}
          </section>
        </div>

        <footer className={styles.footer}>
          <details className={styles.details}>
            <summary className={styles.summary}>About these figures</summary>
            <p className={styles.hint}>{week.footnote}</p>
          </details>
        </footer>
      </div>
    </div>
  );
}
