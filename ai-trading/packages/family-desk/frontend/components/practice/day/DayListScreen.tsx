"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DeskApiError } from "@/lib/api/client";
import { backoffMs } from "@/lib/desk/backoff";
import { LeftRailPortal } from "@/components/shell/desktop/LeftRailPortal";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { FactList } from "@/components/ui/FactList";
import { PracticeNotice } from "@/components/practice/PracticeNotice";
import { EmptyBlock, ErrorBlock } from "@/components/ui/StateBlocks";
import { withPriorities } from "@/lib/desk/columns";
import { formatClock, formatEtDay, formatEtTimeZone, signTone } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { whenReady } from "@/lib/desk/patience";
import { loadDaily, loadDayList, loadThread, openNextDay, relistDay, rescanDay, startDaySession } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { useThreadClock } from "@/lib/replay/useThreadClock";
import { useShellBand } from "@/lib/desk/useViewportBand";
import type { Candidate, DayList } from "@/lib/replay/daily";
import {
  beforeOpen,
  canRescan,
  datesHidden,
  dayCellText,
  dayCellTone,
  dayColumns,
  dayRouteProblem,
  dayTitle,
  type FollowState,
  filtersNote,
  filtersText,
  followState,
  listBuiltText,
  listCountsText,
  listTime,
  listWarning,
  liveState,
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
} from "@/lib/replay/dayView";
import { problemMessage } from "@/lib/replay/setup";
import { dayStatusLine } from "@/lib/replay/statusLine";
import { isSwingDayList, loadAnyDayList } from "@/lib/replay/swingApi";
import { PracticeTabs } from "@/components/practice/hub/PracticeTabs";
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
  return <DayList key={list.data.id} list={list.data} onChanged={list.refresh} failures={list.failures} />;
}

/** One empty layout for a day that is not chosen or not found, with the way back (D-117). */
function DayNotice({ title }: { title: string }) {
  return (
    <div className={styles.body}>
      <PracticeNotice title={title} />
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

function DayList({ list, onChanged, failures }: { list: DayList; onChanged: () => void; failures: number }) {
  const router = useRouter();
  const ended = list.status === "ended";
  const hidden = datesHidden(list.plan.spec) && !ended;
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The name a click is opening.
  const [opening, setOpening] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The gateway cut a slow open short and the screen is asking again; the server is still finishing (D-058, D-059).
  const [still, setStill] = useState<"open" | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  // The re-scan click is on its way to the server; from its answer on, the day list's `rescan_job` says how far it is.
  const [scanning, setScanning] = useState(false);
  // This screen saw a scan run, so when the job reads "done" it can tell her it finished, not just show a new label.
  const [scanSeen, setScanSeen] = useState(false);
  // The plan replaced from a day with no names (D-094).
  const [changing, setChanging] = useState(false);
  // Keyboard focus follows the flow (D-092): the page heading on arrival.
  const titleRef = useRef<HTMLHeadingElement>(null);
  // At the 1180 band the right rail is a tab strip: its tabs open drawers of their own (D-020).
  const band = useShellBand();
  const [railOpen, setRailOpen] = useState<string[]>([]);
  // Peek is its own wide drawer on both bands, so the chart and its level legend have room; the rail keeps the portfolio and the plan.
  const [peeking, setPeeking] = useState(false);

  // The risk plan is the thread's (D-007): read it from the thread, not from the day's plan.
  const threadId = list.thread?.id ?? null;
  const thread = useDeskQuery(`day-thread:${threadId}`, (signal) => loadThread(threadId ?? 0, { signal }), { enabled: threadId !== null });

  // A finished day has no chart to peek at: no request either (D-098).
  const peek = useDeskQuery(`day-peek:${list.id}:${selected}`, (signal) => loadDayList(list.id, { peek: selected ?? undefined }, { signal }), { enabled: selected !== null && !ended });

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  // The badge reads the day clock once practice has started, else the time the list was built (D-014).
  useReportPracticeChrome({ day: list.day, hidden, playhead: list.clock ?? list.list_at, scope: "days", status: dayStatusLine(list) });

  // The name she was last on is the one Resume opens; every name she has opened can be switched back to.
  const practicing = list.sessions.at(-1) ?? null;
  // The list is a snapshot of the list time; the day clock runs on the server (ADR-0018). Once the clock has started, the table is read again with
  // `live`, which prices every name at the clock (nothing later than it). A bar closes once a minute, so a new clock minute (or a new re-scan) is the
  // only thing worth a read. Not the clock's every poll: a read of the whole list takes a while and would be cancelled by the next one.
  const liveClock = useThreadClock(!ended && list.thread?.mode === "day" ? threadId : null);
  const clockMinute = liveClock.clock?.clock ? Math.floor(Date.parse(liveClock.clock.clock) / 60_000) : 0;
  const atClock = useDeskQuery(`day-live:${list.id}`, (signal) => loadDayList(list.id, { live: true }, { signal }), {
    enabled: !ended && list.clock !== null,
    revision: clockMinute * 1000 + (list.rescan?.seq ?? 0),
  });
  // A read from before a re-scan or a re-list is not this list's names any more: until the new read lands, the snapshot shows.
  const read = atClock.data;
  const landed = read !== null && read.data_through === list.data_through && read.rescan?.seq === list.rescan?.seq;
  const rows = !ended && landed ? read.candidates : list.candidates;
  // The table follows the clock from the day's start, so its columns are the settled set from the first paint; the cells the read fills wait as placeholders (D-159).
  const live = followState(list, { candidates: rows }, { landed, failed: atClock.error !== null });
  const columns = columnsOf(list, live);
  const liveAt = rows.find((row) => row.live)?.live?.at ?? list.clock;

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
    setPeeking(true);
  };

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
        setScanSeen(false);
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
  // Latch while rendering (React's "adjust state when a value changes" pattern), not in an effect: a scan seen running is one this
  // screen can announce when it ends. The click clears it, so the previous scan's "done" never shows for the new one.
  if (scanRunning && !scanSeen) setScanSeen(true);
  // The day list is read again every RESCAN_POLL_MS while a scan runs; after reads that failed in a row it waits twice as long per failure (up to a minute).
  const failuresRef = useRef(failures);
  const lastPoll = useRef(0);
  useEffect(() => {
    failuresRef.current = failures;
  });
  useEffect(() => {
    if (!scanRunning) return;
    const timer = setInterval(() => {
      if (document.hidden || (failuresRef.current > 0 && Date.now() - lastPoll.current < backoffMs(RESCAN_POLL_MS, failuresRef.current))) return;
      lastPoll.current = Date.now();
      onChanged();
    }, RESCAN_POLL_MS);
    return () => clearInterval(timer);
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
        <div className={styles.actions}>
          {practicing && !ended && (
            <Button client href={`/practice/replay?id=${practicing.id}`} variant="primary">{practiceText("planOpenDay", { n: threadDayNo(list.plan, list.day_no) })}</Button>
          )}
          {ended &&
            (finishHref !== null ? (
              <Button client href={finishHref} variant="primary">{PRACTICE_COPY.dayFinishPlan}</Button>
            ) : (
              <Button variant="primary" disabled={busy} onClick={() => void next()}>{busy ? PRACTICE_COPY.dayAfterOpening : PRACTICE_COPY.dayAfter}</Button>
            ))}
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
        {message && (retry ? <ErrorBlock message={message} onRetry={retry} /> : <p className={styles.banner} role="alert">{message}</p>)}

        {!ended && (
          <section className={styles.section} aria-label="Candidates">
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Candidates</h2>
            </div>
            <p className={styles.muted} data-testid="open-hint">
              {list.sessions.length === 0 ? (list.relist ? PRACTICE_COPY.dayOpenRelistHint : PRACTICE_COPY.dayOpenHint) : practiceText("daySwitchHint", { time: formatEtTimeZone(list.clock) })}
            </p>
            {live && liveAt && (
              <p className={styles.muted} data-testid="live-note">
                {practiceText(live.today ? "dayLiveNote" : beforeOpen(list.clock) ? "dayLiveNotePre" : "dayLiveNoteOpen", { clock: formatEtTimeZone(liveAt), list: formatEtTimeZone(listTime(list)) })}
              </p>
            )}
            <DenseTable
              caption="Candidates"
              columns={withPriorities(columns, "practiceList")}
              rows={rows}
              rowKey={(row) => row.symbol}
              selectedKey={selected}
              onSelect={(row) => void practice(row.symbol)}
              scrollX
              empty={
                <EmptyBlock title={PRACTICE_COPY.dayNoMatchTitle}>
                  <p className={styles.muted}>{PRACTICE_COPY.dayNoMatchHint}</p>
                  <div className={styles.actions}>
                    {list.sessions.length === 0 && threadId !== null && (
                      <Button client href={`/practice/thread?id=${threadId}`} variant="primary">{PRACTICE_COPY.daySkipOnSummary}</Button>
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
                      aria-label={here ? undefined : practiceText("dayOpen", { symbol: row.symbol })}
                      onClick={() => void practice(row.symbol)}
                    >
                      {here ? practiceText("dayOpening", { symbol: row.symbol }) : PRACTICE_COPY.dayOpenButton}
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
            {scanSeen && list.rescan_job?.state === "done" && list.rescan && (
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
      {peeking && selected !== null && !ended && (
        <Dialog
          title={PRACTICE_COPY.dayPeek}
          size="drawer"
          onClose={() => setPeeking(false)}
          headerActions={<Button onClick={() => setPeeking(false)}>{PRACTICE_COPY.dayPeekClose}</Button>}
        >
          <PeekPanel
            symbol={selected}
            row={list.candidates.find((candidate) => candidate.symbol === selected) ?? null}
            peek={peek.data?.peek ?? null}
            loading={peek.loading}
            failed={peek.data === null && peek.error !== null}
            onRetry={peek.refresh}
            hideDates={datesHidden(list.plan.spec)}
          />
        </Dialog>
      )}
      {changing && thread.data !== null && (
        <NewPlanModal thread={thread.data.thread} onClose={() => setChanging(false)} onSaved={(id) => router.push(`/practice/thread?id=${id}`)} />
      )}
      <RightRail
        label="Day context"
        multi
        openIds={railOpen}
        onOpenIdsChange={setRailOpen}
        sections={[
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
                            ? [{ id: "today", label: PRACTICE_COPY.threadRealizedToday, value: formatDayResult(list.thread.today_pnl_usd), tone: signTone(list.thread.today_pnl_usd) }]
                            : []),
                        ]
                      : []),
                    { id: "window", label: "Practice window", value: `${practiceTime.from}–${practiceTime.to} ET` },
                    { id: "chart", label: "Chart", value: setup.interval },
                    ...(thread.data?.thread.plan ? planRows(thread.data.thread.plan, "day", thread.data.thread.shares).map((row) => ({ id: row.id, label: row.label, value: row.value })) : []),
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

function columnsOf(list: DayList, live: FollowState | null): DenseColumn<Candidate>[] {
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
    ...dayColumns(list, live).map((column): DenseColumn<Candidate> => ({
      key: column.key,
      label: column.label,
      align: column.format === "time" || column.format === "earnings" ? "left" : "right",
      // No name was checked (every cell a dash): the column would be a row of dashes to scroll past (D-136).
      hideWhenEmpty: column.format === "earnings",
      render: (row) => {
        // The read at the clock has not landed: the column is here, its value is on its way (D-159).
        if (live?.pending && column.live) return <Skeleton width={36} height={10} className={styles.pending} />;
        const text = dayCellText(column, row);
        if (column.format === "earnings") return row.earnings_state === "reported" ? <Badge tone="warn">{text}</Badge> : text;
        const tone = dayCellTone(column, row);
        return <span className={tone ? styles[tone] : undefined}>{text}</span>;
      },
    })),
  ];
}
