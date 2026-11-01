"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DeskApiError } from "@/lib/api/client";
import { LeftRailPortal } from "@/components/shell/desktop/LeftRailPortal";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { FactList } from "@/components/ui/FactList";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import { EmptyBlock, ErrorBlock } from "@/components/ui/StateBlocks";
import { withPriorities } from "@/lib/desk/columns";
import { formatClock, formatEtDay, formatEtTimeZone, signTone } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { whenReady } from "@/lib/desk/patience";
import { endDay, loadDaily, loadDayList, loadThread, openNextDay, relistDay, rescanDay, startDaySession } from "@/lib/desk/replay";
import { openRailTab } from "@/lib/desk/rail";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { useShellBand } from "@/lib/desk/useViewportBand";
import type { Candidate, DayList } from "@/lib/replay/daily";
import {
  canRescan,
  cellText,
  cellTone,
  datesHidden,
  dayCellText,
  dayCellTone,
  dayColumns,
  dayRouteProblem,
  dayTitle,
  filtersNote,
  filtersText,
  listBuiltText,
  listCountsText,
  listWarning,
  nameActionLabel,
  practiceWindow,
  rescanCounts,
  rescanCurrent,
  rescanLabel,
  rescanProgressText,
  rescanRunning,
  rescanStaleText,
  sourceNote,
  threadDayNo,
  universeNote,
  endDayExitText,
  portfolioRows,
} from "@/lib/replay/dayView";
import { resumeDayLabel } from "@/lib/replay/boardView";
import { problemMessage } from "@/lib/replay/setup";
import { dayStatusLine } from "@/lib/replay/statusLine";
import { isSwingDayList, loadAnyDayList } from "@/lib/replay/swingApi";
import { PracticeTabs } from "@/components/practice/hub/PracticeTabs";
import { useDayPortfolio } from "@/components/practice/replay/Portfolio";
import { NewPlanModal } from "@/components/practice/hub/NewPlanModal";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { SwingBoard } from "@/components/practice/swing/SwingBoard";
import { ThreadStrip } from "@/components/practice/thread/ThreadStrip";
import { formatBalance, formatDayResult, planRows } from "@/lib/replay/threadView";
import { DayLeftPanel } from "./DayLeftPanel";
import { PeekPanel } from "./PeekPanel";
import { ReviewPanel } from "./ReviewPanel";
import { UniverseFootnote } from "./UniverseFootnote";
import styles from "./day.module.css";
import { Skeleton } from "@/components/ui/StateBlocks";

/** The day list is read again this often while a re-scan is running, so its count of names read moves. */
const RESCAN_POLL_MS = 1000;

/** `/practice/day?id=`: the day's candidate list before the open, then the review after it (02o-b v1). Reads the URL, so the page wraps it in Suspense. */
export function DayListScreen() {
  const router = useRouter();
  const raw = useSearchParams().get("id");
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const list = useDeskQuery(`day-list:${id}`, (signal) => loadAnyDayList(id ?? 0, {}, { signal }), { enabled: id !== null });
  // No id: the day she has open, if any, is the one she means (a bookmark or the bare route).
  const daily = useDeskQuery("replay-daily", (signal) => loadDaily({ signal }), { enabled: id === null });
  const openDay = daily.data?.plan?.current ?? null;
  const openDayId = openDay !== null && openDay.status !== "ended" ? openDay.id : null;
  useEffect(() => {
    if (id === null && openDayId !== null) router.replace(`/practice/day?id=${openDayId}`);
  }, [id, openDayId, router]);

  // No id is "not chosen"; an id that is no number, or that the server does not know, is "not found" (D-117).
  const problem = dayRouteProblem(raw);
  const notFound = problem === "missing" || (list.error instanceof DeskApiError && list.error.status === 404);
  if (id === null && problem === "missing") return <DayNotice title={PRACTICE_COPY.dayNotFound} />;
  if (id === null) {
    // A failed read is not "no day selected": say it failed and offer the retry (F-10).
    if (daily.data === null && daily.error !== null) {
      return (
        <div className={styles.body}>
          <ErrorBlock message={PRACTICE_COPY.dayLoadError} onRetry={daily.refresh} />
        </div>
      );
    }
    if (daily.loading || openDayId !== null) return <DaySkeleton />;
    return <DayNotice title={PRACTICE_COPY.dayNoPlan} />;
  }
  if (list.data === null) {
    if (notFound) return <DayNotice title={PRACTICE_COPY.dayNotFound} />;
    return list.error === null ? (
      <DaySkeleton />
    ) : (
      <div className={styles.body}>
        <ErrorBlock message={PRACTICE_COPY.dayLoadError} onRetry={list.refresh} />
      </div>
    );
  }
  // A swing thread's day answers the swing board (02p d1); a day thread's list is the screen below.
  if (isSwingDayList(list.data)) return <SwingBoard key={list.data.id} initial={list.data} />;
  return <DayList key={list.data.id} list={list.data} onChanged={list.refresh} />;
}

/** One empty layout for a day that is not chosen or not found, with the way back (D-117). */
function DayNotice({ title }: { title: string }) {
  return (
    <div className={styles.body}>
      <EmptyBlock framed title={title} action={{ label: PRACTICE_COPY.openPractice, href: "/practice", primary: true }} />
    </div>
  );
}

/** The day page while it loads: grey blocks where the header, the counts, the candidate rows and the left rail will be (D-116). */
function DaySkeleton() {
  return (
    <div className={styles.screen} role="status" aria-busy="true" aria-label={PRACTICE_COPY.dayLoading}>
      <header className={styles.header}>
        <Skeleton width={280} height={18} />
      </header>
      <div className={styles.body}>
        <Skeleton width="60%" />
        <Skeleton width="60%" />
        <Skeleton height={240} />
      </div>
      <LeftRailPortal>
        <div className={styles.side} aria-hidden="true">
          <section className={styles.sideSection}>
            <Skeleton width={96} height={11} />
            <Skeleton height={72} />
          </section>
          <section className={styles.sideSection}>
            <Skeleton width={120} height={11} />
            <Skeleton height={96} />
          </section>
        </div>
      </LeftRailPortal>
    </div>
  );
}

function DayList({ list, onChanged }: { list: DayList; onChanged: () => void }) {
  const router = useRouter();
  const ended = list.status === "ended";
  const hidden = datesHidden(list.plan.spec) && !ended;
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The name a click is opening.
  const [opening, setOpening] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The gateway cut a slow open or end short and the screen is asking again; the server is still finishing (D-058, D-059).
  const [still, setStill] = useState<"open" | "end" | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  // The re-scan click is on its way to the server; from its answer on, the day list's `rescan_job` says how far it is.
  const [scanning, setScanning] = useState(false);
  // A scan this screen watched run has finished: say so until the next one starts.
  const [scanDone, setScanDone] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // "Skip this day" (an empty list) ends the day like End day does, so it asks first too (F-11).
  const [confirmSkip, setConfirmSkip] = useState(false);
  const skipRef = useRef<HTMLButtonElement>(null);
  // The plan replaced from a day with no names (D-094).
  const [changing, setChanging] = useState(false);
  // Keyboard focus follows the flow (D-092, D-093): the page heading on arrival, then the confirm (InlineConfirm) when it opens and
  // the trigger when it closes, and the control that replaces End day once the day has ended.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const endRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const endedHere = useRef(false);
  // At the 1180 band the right rail is a tab strip: a row click opens the Peek drawer and the others stay as they are (D-020).
  const band = useShellBand();
  const [railOpen, setRailOpen] = useState<string[]>([]);

  // The risk plan is the thread's (D-007): read it from the thread, not from the day's plan.
  const threadId = list.thread?.id ?? null;
  const thread = useDeskQuery(`day-thread:${threadId}`, (signal) => loadThread(threadId ?? 0, { signal }), { enabled: threadId !== null });

  // A finished day has no chart to peek at: no request either (D-098).
  const peek = useDeskQuery(`day-peek:${list.id}:${selected}`, (signal) => loadDayList(list.id, { peek: selected ?? undefined }, { signal }), { enabled: selected !== null && !ended });

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (ended && endedHere.current) {
      endedHere.current = false;
      nextRef.current?.focus({ preventScroll: true });
    }
  }, [ended]);

  // The badge reads the day clock once practice has started, else the time the list was built (D-014).
  useReportPracticeChrome({ day: list.day, hidden, playhead: list.clock ?? list.list_at, scope: "days", status: dayStatusLine(list) });

  // The name she was last on is the one Resume opens; every name she has opened can be switched back to.
  const practicing = list.sessions.at(-1) ?? null;
  const opened = new Set(list.sessions.map((session) => session.symbol));
  const columns = columnsOf(list);
  // The End-day confirm names the open trades from this read, which re-reads whenever the day page's own data moves (a name opened, the day ended).
  const portfolioRevision = list.sessions.length * 2 + (ended ? 1 : 0);
  const portfolio = useDayPortfolio(list.id, portfolioRevision);
  const exits = endDayExitText(portfolioRows(portfolio.data ?? list), list.clock);

  async function run(action: () => Promise<void>, fallback: string, again: (() => void) | null = null) {
    setBusy(true);
    setMessage(null);
    setRetry(null);
    try {
      await action();
    } catch (error) {
      setMessage(problemMessage(error, fallback));
      setRetry(() => again);
    } finally {
      setStill(null);
      setBusy(false);
    }
  }

  // A click on a candidate opens its practice chart at the day clock; a second click while one opens does nothing.
  const practice = (symbol: string) => {
    if (busy) return Promise.resolve();
    setOpening(symbol);
    return run(async () => {
      const session = await startDaySession(list.id, symbol);
      router.push(`/practice/replay?id=${session.id}`);
    }, PRACTICE_COPY.dayStartError).finally(() => setOpening(null));
  };
  const peekAt = (symbol: string) => {
    setSelected(symbol);
    if (band === "1180") setRailOpen((open) => openRailTab(open, "peek"));
  };

  // Ending is safe to ask twice (the server answers an ended day the same), so a gateway cut waits and asks again, as the replay does (F-08).
  const finish = (): Promise<void> =>
    run(
      async () => {
        await whenReady(() => endDay(list.id), { onWaiting: () => setStill("end") });
        endedHere.current = true;
        setConfirmEnd(false);
        setConfirmSkip(false);
        onChanged();
      },
      PRACTICE_COPY.dayEndError,
      () => void finish(),
    );

  const relist = (listAt: string) =>
    run(async () => {
      const result = await relistDay(list.id, listAt);
      if (result.plan.prep.state === "running" && result.screen.list_at !== listAt) setMessage(PRACTICE_COPY.dayRelistPreparing);
      onChanged();
    }, PRACTICE_COPY.dayRelistError);

  // A re-scan runs on the server in the background: the click only starts it, and the day list (polled while the job says
  // "running") carries how far it has read. Asking twice is safe: a scan already running is joined, never doubled.
  const rescan = (): Promise<void> =>
    run(
      async () => {
        setScanning(true);
        setScanDone(false);
        try {
          await rescanDay(list.id);
        } finally {
          setScanning(false);
        }
        onChanged();
      },
      PRACTICE_COPY.dayRescanError,
      () => void rescan(),
    );
  const scanRunning = rescanRunning(list);
  useEffect(() => {
    if (!scanRunning) return;
    // Remember that this screen saw it run, so its end can be told ("Re-scan finished"), not just shown as a new label.
    setScanDone(false);
    const timer = setInterval(() => {
      if (!document.hidden) onChanged();
    }, RESCAN_POLL_MS);
    return () => {
      clearInterval(timer);
      setScanDone(true);
    };
  }, [scanRunning, onChanged]);

  // The server builds the next list before it answers, so the button says it is opening and stays disabled until the new
  // day's screen replaces this one (D-046): no second click, and no look of nothing happening.
  async function next() {
    setBusy(true);
    setMessage(null);
    setRetry(null);
    try {
      const result = await whenReady(() => openNextDay(undefined, threadId === null ? {} : { threadId }), { onWaiting: () => setStill("open") });
      if (result.day_list_id === null) {
        // The next day's data is still being prepared: stay here with a retry (the hub row does the same), not on a page that says nothing of it (F-09).
        setMessage(PRACTICE_COPY.dayNextPreparing);
        setRetry(() => () => void next());
        setStill(null);
        setBusy(false);
        return;
      }
      router.push(`/practice/day?id=${result.day_list_id}`);
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.planStartError));
      setRetry(() => () => void next());
      setStill(null);
      setBusy(false);
    }
  }

  const warning = listWarning(list);
  const title = dayTitle(list, hidden);
  const setup = list.plan.spec.setup;
  const practiceTime = practiceWindow(list);
  // Day 5 of 5: there is no next day to open, so the button says what it does and goes to the plan's summary (D-096).
  // A re-scan with nothing to scan from (no list and no name, so no day clock) is a dead end: it is not offered (D-094).
  const showRescan = ended ? list.rescan !== null : list.candidates.length > 0 || list.rescan !== null;
  const finishHref = list.plan.finished ? (threadId === null ? "/practice" : `/practice/thread?id=${threadId}`) : null;

  return (
    <div className={styles.screen} data-drawer={band === "1180" && railOpen.length > 0 ? "open" : undefined}>
      <PracticeTabs threadId={list.thread?.id ?? list.plan.thread_id} active="day" mode={list.thread?.mode} />
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 ref={titleRef} tabIndex={-1} className={styles.title}>{title}</h1>
          <Badge tone="neutral">Practice day list</Badge>
          {hidden && <Badge tone="neutral">{PRACTICE_COPY.dayDateHidden}</Badge>}
        </div>
        <div className={`${styles.actions} ${styles.endWrap}`}>
          {practicing && !ended && (
            <Button client href={`/practice/replay?id=${practicing.id}`} variant="primary">{resumeDayLabel(threadDayNo(list.plan, list.day_no))}</Button>
          )}
          {ended ? (
            finishHref !== null ? (
              <Button client href={finishHref} variant="primary">{PRACTICE_COPY.dayFinishPlan}</Button>
            ) : (
              <Button ref={nextRef} variant="primary" disabled={busy} onClick={() => void next()}>{busy ? PRACTICE_COPY.dayAfterOpening : PRACTICE_COPY.dayAfter}</Button>
            )
          ) : (
            <>
              <Button ref={endRef} disabled={busy} aria-expanded={confirmEnd} onClick={() => setConfirmEnd(true)}>{PRACTICE_COPY.dayEnd}</Button>
              {confirmEnd && (
                <InlineConfirm
                  label="Confirm ending the day"
                  layout="floating"
                  size="md"
                  className={styles.endAnchor}
                  prompt={
                    <>
                      <span>{PRACTICE_COPY.dayEndWarning}</span>
                      {exits && <span>{exits}</span>}
                    </>
                  }
                  confirmLabel={PRACTICE_COPY.dayEndYes}
                  cancelLabel={PRACTICE_COPY.dayKeepPracticing}
                  busy={busy}
                  returnFocus={endRef}
                  onConfirm={() => void finish()}
                  onCancel={() => setConfirmEnd(false)}
                />
              )}
            </>
          )}
        </div>
      </header>
      {list.thread && <ThreadStrip thread={list.thread} />}
      <div className={styles.body}>
        <p className={styles.line}>
          {listCountsText(list)}
          {list.rescan ? (
            <span className={styles.built} data-testid="rescan-label">{rescanLabel(list.rescan)}</span>
          ) : (
            <span className={styles.built}>{listBuiltText(list)}</span>
          )}
        </p>
        <div className={styles.filterRow}>
          <span className={styles.filterLabel}>{PRACTICE_COPY.planFilters}</span>
          <ul className={styles.chips} aria-label="Filters">
            {list.screen.filters.map((filter) => {
              const counts = list.universe.filters.find((item) => item.id === filter.id);
              return (
                <li key={filter.id} data-active="true" title={counts ? `${counts.matches_total} matched` : undefined}><Badge tone="warn">{filter.name}</Badge></li>
              );
            })}
          </ul>
          <span className={styles.filterNote}>{filtersNote(list.screen.filters.length)}</span>
        </div>
        {warning && <p className={styles.banner} role="status">{warning}</p>}
        {list.relist && (
          <div className={styles.actions}>
            <Button variant="primary" disabled={busy} onClick={() => void relist(list.relist!.list_at)}>{list.relist.label}</Button>
            {list.relist.window_from && <span className={styles.muted}>{practiceText("dayRelistWindow", { time: formatClock(list.relist.window_from) })}</span>}
          </div>
        )}
        {still === "open" && <p className={styles.banner} role="status">{PRACTICE_COPY.planStillWorking}</p>}
        {still === "end" && <p className={styles.banner} role="status">{PRACTICE_COPY.dayEndStillWorking}</p>}
        {message && (retry ? <ErrorBlock message={message} onRetry={retry} /> : <p className={styles.banner} role="alert">{message}</p>)}

        {!ended && (
          <section className={styles.section} aria-label="Candidates">
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Candidates</h2>
            </div>
            <p className={styles.muted} data-testid="open-hint">
              {list.clock === null ? (list.relist ? PRACTICE_COPY.dayOpenRelistHint : PRACTICE_COPY.dayOpenHint) : practiceText("daySwitchHint", { time: formatEtTimeZone(list.clock) })}
            </p>
            <DenseTable
              caption="Candidates"
              columns={withPriorities(columns, "practiceList")}
              rows={list.candidates}
              rowKey={(row) => row.symbol}
              selectedKey={selected}
              onSelect={(row) => void practice(row.symbol)}
              scrollX
              empty={
                <EmptyBlock title={PRACTICE_COPY.dayNoMatchTitle}>
                  <p className={styles.muted}>{PRACTICE_COPY.dayNoMatchHint}</p>
                  <div className={styles.actions}>
                    {list.sessions.length === 0 && !confirmSkip && (
                      <Button ref={skipRef} variant="primary" disabled={busy} onClick={() => setConfirmSkip(true)}>{PRACTICE_COPY.daySkip}</Button>
                    )}
                    {list.sessions.length === 0 && confirmSkip && (
                      <InlineConfirm
                        label="Confirm skipping the day"
                        layout="block"
                        size="md"
                        prompt={<span>{PRACTICE_COPY.daySkipWarning}</span>}
                        confirmLabel={PRACTICE_COPY.daySkipYes}
                        cancelLabel={PRACTICE_COPY.dayKeepPracticing}
                        busy={busy}
                        returnFocus={skipRef}
                        onConfirm={() => void finish()}
                        onCancel={() => setConfirmSkip(false)}
                      />
                    )}
                    {thread.data !== null && <Button onClick={() => setChanging(true)}>{PRACTICE_COPY.dayChangePlan}</Button>}
                  </div>
                </EmptyBlock>
              }
              rowActions={(row) => {
                const here = opening === row.symbol;
                return (
                  <span className={styles.actions}>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      loading={here}
                      aria-label={here ? undefined : practiceText(opened.has(row.symbol) ? "daySwitch" : "dayOpen", { symbol: row.symbol })}
                      onClick={() => void practice(row.symbol)}
                    >
                      {here ? practiceText("dayOpening", { symbol: row.symbol }) : nameActionLabel(opened.has(row.symbol))}
                    </Button>
                    <Button size="sm" variant="primary" disabled={busy} aria-label={practiceText("dayPeekAt", { symbol: row.symbol })} onClick={() => peekAt(row.symbol)}>
                      {PRACTICE_COPY.dayPeek}
                    </Button>
                  </span>
                );
              }}
            />
            <UniverseFootnote text={universeNote(list.universe)} />
            <UniverseFootnote text={sourceNote(list)} />
          </section>
        )}

        {ended && list.review && <ReviewPanel review={list.review} journal={list.journal} footnote={list.universe.footnote} />}

        {showRescan && (
          <section className={styles.section} aria-label="Re-scan">
            <h2 className={styles.sectionTitle}>{PRACTICE_COPY.dayRescanTitle}</h2>
            {!ended && (
              <div className={styles.actions}>
                <Button disabled={busy || scanning || scanRunning || !canRescan(list) || rescanCurrent(list)} onClick={() => void rescan()}>
                  {scanning || scanRunning ? PRACTICE_COPY.dayRescanning : PRACTICE_COPY.dayRescan}
                </Button>
                {!scanRunning && (
                  <span className={styles.muted} data-testid="rescan-hint">
                    {!canRescan(list) ? PRACTICE_COPY.dayRescanNeedsClock : rescanCurrent(list) ? PRACTICE_COPY.dayRescanCurrent : PRACTICE_COPY.dayRescanHint}
                  </span>
                )}
              </div>
            )}
            {list.rescan_job?.state === "running" && (
              <div className={styles.scanProgress} data-testid="rescan-progress">
                <progress
                  className={styles.scanBar}
                  max={Math.max(list.rescan_job.total, 1)}
                  value={list.rescan_job.total === 0 ? undefined : list.rescan_job.done}
                  aria-label={PRACTICE_COPY.dayRescanProgressLabel}
                  aria-valuetext={rescanProgressText(list.rescan_job)}
                />
                <span className={styles.muted} data-testid="rescan-progress-text">{rescanProgressText(list.rescan_job)}</span>
              </div>
            )}
            {list.rescan_job?.state === "failed" && !ended && (
              <p className={styles.banner} role="alert" data-testid="rescan-failed">{list.rescan_job.message ?? PRACTICE_COPY.dayRescanError}</p>
            )}
            {scanDone && list.rescan_job?.state === "done" && list.rescan && (
              <p className={styles.muted} role="status" data-testid="rescan-done">{practiceText("dayRescanDone", { seq: list.rescan.seq })}</p>
            )}
            {list.rescan && (
              <>
                <p className={styles.muted} data-testid="rescan-counts">{rescanCounts(list)}</p>
                {!ended && rescanStaleText(list) && <p className={styles.muted} role="status" data-testid="rescan-stale">{rescanStaleText(list)}</p>}
              </>
            )}
          </section>
        )}

        {ended && list.plan.finished && <p className={styles.muted}>{PRACTICE_COPY.dayFinished}</p>}
      </div>
      <DayLeftPanel list={list} />
      {changing && thread.data !== null && (
        <NewPlanModal thread={thread.data.thread} onClose={() => setChanging(false)} onSaved={(id) => router.push(`/practice/thread?id=${id}`)} />
      )}
      <RightRail
        label="Day context"
        multi
        openIds={railOpen}
        onOpenIdsChange={setRailOpen}
        sections={[
          ...(ended
            ? []
            : [
                {
                  id: "peek",
                  label: PRACTICE_COPY.dayPeek,
                  node: (
                    <PeekPanel
                      symbol={selected}
                      row={list.candidates.find((candidate) => candidate.symbol === selected) ?? null}
                      peek={peek.data?.peek ?? null}
                      loading={peek.loading}
                      failed={peek.data === null && peek.error !== null}
                      onRetry={peek.refresh}
                      hideDates={datesHidden(list.plan.spec)}
                    />
                  ),
                },
              ]),
          {
            id: "plan",
            label: list.thread ? PRACTICE_COPY.threadPlanTitle : "Plan",
            node: (
              <>
                <FactList
                  facts={[
                    ...(list.thread
                      ? [
                          { id: "balance", label: PRACTICE_COPY.threadBalance, value: <>{formatBalance(list.thread.balance)} <SimulatedBadge /></> },
                          ...(list.thread.today_pnl_usd !== null
                            ? [{ id: "today", label: PRACTICE_COPY.threadToday, value: formatDayResult(list.thread.today_pnl_usd), tone: signTone(list.thread.today_pnl_usd) }]
                            : []),
                        ]
                      : []),
                    { id: "window", label: "Practice window", value: `${practiceTime.from}–${practiceTime.to} ET` },
                    { id: "chart", label: "Chart", value: setup.interval },
                    ...(thread.data?.thread.plan ? planRows(thread.data.thread.plan).map((row) => ({ id: row.id, label: row.label, value: row.value })) : []),
                    ...(ended ? [{ id: "day", label: "Day", value: formatEtDay(list.day) }] : []),
                  ]}
                />
                {list.thread && <p className={styles.muted}>{PRACTICE_COPY.threadPlanFrom}</p>}
              </>
            ),
          },
        ]}
      />
    </div>
  );
}

function columnsOf(list: DayList): DenseColumn<Candidate>[] {
  return [
    {
      key: "symbol",
      label: "Symbol",
      render: (row) => (
        <span>
          <span className={styles.symbol}>{row.symbol}</span>
          {row.new_since_list && <Badge tone="warn" style={{ marginLeft: 6 }}>{PRACTICE_COPY.dayRescanNew}</Badge>}
          {row.held_over && <Badge tone="neutral" style={{ marginLeft: 6 }}>{PRACTICE_COPY.dayRescanHeld}</Badge>}
        </span>
      ),
    },
    { key: "filters", label: "Filters", render: (row) => filtersText(row) },
    ...dayColumns(list).map((column): DenseColumn<Candidate> => ({
      key: column.key,
      label: column.label,
      align: column.format === "time" || column.format === "earnings" ? "left" : "right",
      // No name reports before the open: the column would be a row of dashes to scroll past (D-136).
      hideWhenEmpty: column.format === "earnings",
      render: (row) => {
        const text = dayCellText(column, row);
        if (column.format === "earnings") return text === "—" ? text : <Badge tone="warn">{text}</Badge>;
        if (column.missing) return <span title={PRACTICE_COPY.dayNoValue}>{text}</span>;
        const tone = dayCellTone(column, row);
        return <span className={tone ? styles[tone] : undefined}>{text}</span>;
      },
    })),
  ];
}
