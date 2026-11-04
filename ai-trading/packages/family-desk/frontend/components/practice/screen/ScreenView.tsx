"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DeskApiError } from "@/lib/api/client";
import { backoffMs } from "@/lib/desk/backoff";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { FactList } from "@/components/ui/FactList";
import { PracticeNotice } from "@/components/practice/PracticeNotice";
import { EmptyBlock, ErrorBlock, Skeleton } from "@/components/ui/StateBlocks";
import { SCREEN_WIDTH_CAPS, withPriorities } from "@/lib/desk/columns";
import { formatEtDateClock, formatEtDateTimeZone, formatEtTimeZone } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadScreen, loadThread, openLane, patchScreen, rescanScreen } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { PracticeTabs } from "@/components/practice/hub/PracticeTabs";
import { ThreadPicker } from "@/components/practice/journal/thread/ThreadPicker";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { ThreadStrip } from "@/components/practice/thread/ThreadStrip";
import { replayHref, screenHref, threadPageHref } from "@/lib/replay/practiceTabs";
import { routeId } from "@/lib/replay/routeId";
import type { Candidate, Screen } from "@/lib/replay/screen";
import {
  beforeOpen,
  canRescan,
  filtersNote,
  filtersText,
  followState,
  heldFirst,
  isStarred,
  laneLine,
  minuteOfClock,
  neverScanned,
  rescanCounts,
  rescanCurrent,
  rescanProgressText,
  rescanRefusedText,
  rescanRunning,
  rescanStaleText,
  riskPlanText,
  scanBuiltText,
  screenCellText,
  screenCellTitle,
  screenCellTone,
  screenColumns,
  screenCountsText,
  screenTitle,
  screenWarnings,
  sourceNote,
  toggledStars,
  universeNote,
  type FollowState,
} from "@/lib/replay/screenView";
import { readScreenRefusal, writeScreenRefusal, type ScreenRefusal } from "@/lib/replay/screenRefusal";
import { problemMessage } from "@/lib/replay/setup";
import { screenStatusLine, type PracticeStatusLine } from "@/lib/replay/statusLine";
import { formatBalance } from "@/lib/replay/threadView";
import { useThreadClock } from "@/lib/replay/useThreadClock";
import { PeekPanel } from "./PeekPanel";
import { UniverseFootnote } from "./UniverseFootnote";
import styles from "./screen.module.css";

/** The Screen is read again this often while a scan is running, so its count of names read moves. */
const RESCAN_POLL_MS = 1000;

/** `/practice/screen?thread=`: the scan of her saved filters at the thread's time T, her stars and the names she opened (ADR-0025). Reads the URL, so the page wraps it in Suspense. */
export function ScreenView() {
  const { id, given } = routeId(useSearchParams().get("thread"));
  const screen = useDeskQuery(`screen:${id}`, (signal) => loadScreen(id ?? 0, {}, { signal }), { enabled: id !== null });
  // No id is "not chosen"; an id that is no number, or that the server does not know, is "not found" (D-117, D-193).
  if (id === null && !given) {
    return (
      <div className={styles.body}>
        <ThreadPicker hint={PRACTICE_COPY.screenPickHint} href={screenHref} />
      </div>
    );
  }
  if (id === null) return <ScreenNotice title={PRACTICE_COPY.threadPageNotFound} />;
  if (screen.data === null) {
    if (screen.error instanceof DeskApiError && screen.error.status === 404) return <ScreenNotice title={PRACTICE_COPY.threadPageNotFound} />;
    // A thread without a setup has no Screen yet (409): say so, with the way to its Summary.
    if (screen.error instanceof DeskApiError && screen.error.status === 409) {
      return (
        <div className={styles.screen}>
          <PracticeTabs threadId={id} active="screen" />
          <div className={styles.body}>
            <EmptyBlock framed title={PRACTICE_COPY.screenNoSetup} action={{ label: PRACTICE_COPY.screenToSummary, href: threadPageHref(id), primary: true }}>
              <p className={styles.muted}>{PRACTICE_COPY.screenNoSetupHint}</p>
            </EmptyBlock>
          </div>
        </div>
      );
    }
    return screen.error === null ? (
      <ScreenSkeleton />
    ) : (
      <div className={styles.body}>
        <ErrorBlock message={PRACTICE_COPY.screenLoadError} onRetry={screen.refresh} />
      </div>
    );
  }
  return <ScreenBody key={screen.data.id} screen={screen.data} onChanged={screen.refresh} failures={screen.failures} />;
}

/** One empty layout for a thread that is not chosen or not found, with the way back (D-117). */
function ScreenNotice({ title }: { title: string }) {
  return (
    <div className={styles.body}>
      <PracticeNotice title={title} />
    </div>
  );
}

/** The Screen while it loads: grey blocks where the header, the counts and the candidate rows will be (D-116). */
function ScreenSkeleton() {
  return (
    <div className={styles.screen} role="status" aria-busy="true" aria-label={PRACTICE_COPY.screenLoading}>
      <header className={styles.header}>
        <Skeleton width={280} height={18} />
      </header>
      <div className={styles.body}>
        <Skeleton width="60%" />
        <Skeleton width="60%" />
        <Skeleton height={240} />
      </div>
    </div>
  );
}

function ScreenBody({ screen, onChanged, failures }: { screen: Screen; onChanged: () => void; failures: number }) {
  const router = useRouter();
  const threadId = screen.thread_id;
  // A closed thread's time is frozen: its Screen is read, not scanned, starred or opened (the server refuses all three).
  const closed = screen.thread?.status === "closed";
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The name a click is opening.
  const [opening, setOpening] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  // The scan click is on its way to the server; from its answer on, the Screen's `rescan_job` says how far it is.
  const [scanning, setScanning] = useState(false);
  // This screen saw a scan run, so when the job reads "done" it can tell her it finished, not just show a new label.
  const [scanSeen, setScanSeen] = useState(false);
  // The server refused a scan because every filter waits for its first bar (409): only the thread clock changes that (D-234). The minute it was refused in, and its reason.
  // It is the thread's, not this page's: read from the tab's session storage so a return to the Screen or a reload at the same minute still has it (D-239).
  const [refused, setRefusedState] = useState<ScreenRefusal | null>(() => readScreenRefusal(window.sessionStorage, threadId));
  const setRefused = (next: ScreenRefusal | null) => {
    setRefusedState(next);
    writeScreenRefusal(window.sessionStorage, threadId, next);
  };
  // Keyboard focus follows the flow (D-092): the page heading on arrival.
  const titleRef = useRef<HTMLHeadingElement>(null);
  // At the 1180 band the right rail is a tab strip: its tabs open drawers of their own (D-020).
  const band = useShellBand();
  const [railOpen, setRailOpen] = useState<string[]>([]);
  // Peek is its own wide drawer on both bands, so the chart and its level legend have room; the rail keeps the plan.
  const [peeking, setPeeking] = useState(false);

  // The risk plan is the thread's (D-007): read it from the thread.
  const thread = useDeskQuery(`screen-thread:${threadId}`, (signal) => loadThread(threadId, { signal }));
  const peek = useDeskQuery(`screen-peek:${threadId}:${selected}`, (signal) => loadScreen(threadId, { peek: selected ?? undefined }, { signal }), { enabled: selected !== null });

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  // The Screen is a snapshot of the scan; the thread clock runs on the server (ADR-0018). Once names are listed, the table is read again with `live`, which
  // prices every name at T (nothing later). A bar closes once a minute, so a new clock minute (or a new scan) is the only thing worth a read. Not the
  // clock's every poll: a read of the whole Screen takes a while and would be cancelled by the next one.
  const liveClock = useThreadClock(closed ? null : threadId);
  const clockMinute = liveClock.clock?.clock ? Math.floor(Date.parse(liveClock.clock.clock) / 60_000) : 0;
  const atClock = useDeskQuery(`screen-live:${threadId}`, (signal) => loadScreen(threadId, { live: true }, { signal }), {
    enabled: !closed && screen.candidates.length > 0,
    revision: clockMinute * 1000 + (screen.rescan?.seq ?? 0),
  });
  // A read from before a scan is not this Screen's names any more: until the new read lands, the snapshot shows.
  const read = atClock.data;
  const landed = read !== null && read.data_through === screen.data_through && read.rescan?.seq === screen.rescan?.seq;
  const rows = !closed && landed ? read.candidates : screen.candidates;
  const lanes = heldFirst(!closed && landed ? read.lanes : screen.lanes);
  // The thread's one time T, as the latest answer has it (ADR-0022): the label, the chip and the Summary's clock all read it, so they agree.
  const clock = liveClock.clock?.clock ?? (landed ? read.clock : null) ?? screen.clock;
  const shown = (closed ? null : liveClock.shown) ?? clock;
  const day = landed ? read.day : screen.day;
  // The table follows the clock from the first scan, so its columns are the settled set from the first paint; the cells the read fills wait as placeholders (D-159).
  const live = followState({ clock, thread: screen.thread }, { candidates: rows }, { landed, failed: atClock.error !== null });
  // One list of columns while nothing it reads changes, so the table is measured when its columns change, not on every render the clock's poll causes (D-235).
  const following = live !== null;
  const today = live?.today ?? false;
  const pending = live?.pending ?? false;
  const columns = useMemo(
    () =>
      withPriorities(
        columnsOf({ columns: screen.columns, universe: screen.universe }, following ? { today, pending } : null),
        // A scan read after the open adds the scan's own RVOL and change % to the previous session's: which of them give way is that board's (D-243).
        screen.universe.prev_basis ? "practiceList" : "practiceListOpen",
      ),
    [screen.columns, screen.universe, following, today, pending],
  );
  const liveAt = rows.find((row) => row.live)?.live?.at ?? clock;
  const market = (landed ? read.market : null) ?? screen.market ?? null;
  const last = lanes.filter((lane) => lane.status === "active").at(-1) ?? null;

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
      setBusy(false);
    }
  }

  // A click on a candidate opens its lane at the thread clock; a second click while one opens does nothing.
  const practice = (symbol: string) => {
    if (busy || closed) return Promise.resolve();
    setOpening(symbol);
    return run(async () => {
      const lane = await openLane(threadId, symbol);
      router.push(replayHref(lane.id));
    }, PRACTICE_COPY.screenOpenError).finally(() => setOpening(null));
  };
  const peekAt = (symbol: string) => {
    setSelected(symbol);
    setPeeking(true);
  };
  const toggleStar = (symbol: string) =>
    run(async () => {
      await patchScreen(threadId, { watch: toggledStars(screen.watch, symbol) });
      onChanged();
    }, PRACTICE_COPY.screenStarError);

  // A scan runs on the server in the background: the click only starts it, and the Screen (polled while the job says
  // "running") carries how far it has read. Asking twice is safe: a scan already running is joined, never doubled.
  const rescan = (): Promise<void> =>
    run(
      async () => {
        setScanning(true);
        setScanSeen(false);
        setRefused(null);
        try {
          await rescanScreen(threadId);
        } catch (error) {
          // 409: every filter waits for its first bar of the day. Asking again at the same time gets the same answer, so say where time moves instead of offering a retry (D-234).
          if (!(error instanceof DeskApiError && error.status === 409)) throw error;
          setRefused({ minute: minuteOfClock(clock), reason: problemMessage(error, PRACTICE_COPY.screenRescanError) });
          return;
        } finally {
          setScanning(false);
        }
        onChanged();
      },
      PRACTICE_COPY.screenRescanError,
      () => void rescan(),
    );
  const scanRunning = rescanRunning(screen);
  // Latch while rendering (React's "adjust state when a value changes" pattern), not in an effect: a scan seen running is one this
  // screen can announce when it ends. The click clears it, so the previous scan's "done" never shows for the new one.
  if (scanRunning && !scanSeen) setScanSeen(true);
  // The Screen is read again every RESCAN_POLL_MS while a scan runs; after reads that failed in a row it waits twice as long per failure (up to a minute).
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

  // The refusal stands for the clock minute it was made in; once the clock moves, a scan is worth asking for again. A closed thread is refused for its own reason, which its hint already gives.
  const refusal = refused !== null && refused.minute === minuteOfClock(clock) && canRescan(screen) ? refused.reason : null;
  const unscanned = neverScanned(screen);
  const current = rescanCurrent({ clock, rescan: screen.rescan });
  const stale = rescanStaleText({ clock, rescan: screen.rescan });
  const plan = thread.data?.thread.plan ?? null;

  return (
    <div className={styles.screen} data-drawer={band === "1180" && railOpen.length > 0 ? "open" : undefined}>
      <PracticeTabs threadId={threadId} active="screen" />
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 ref={titleRef} tabIndex={-1} className={styles.title}>{screenTitle({ day })}</h1>
          <Badge tone="neutral">{PRACTICE_COPY.screenBadge}</Badge>
        </div>
        <ScreenClock day={day} shown={shown} status={screenStatusLine(screen)} market={market} />
        <div className={styles.actions}>
          {last !== null && (
            <Button client href={replayHref(last.id)} variant="primary">{practiceText("screenContinue", { symbol: last.symbol })}</Button>
          )}
        </div>
      </header>
      {screen.thread && <ThreadStrip thread={screen.thread} />}
      <div className={styles.body}>
        <p className={styles.line}>
          {!unscanned && <span>{screenCountsText(screen)}</span>}
          <span className={styles.built} data-testid="rescan-label">{scanBuiltText(screen)}</span>
        </p>
        <div className={styles.filterRow}>
          <span className={styles.filterLabel}>{PRACTICE_COPY.planFilters}</span>
          <ul className={styles.chips} aria-label="Filters">
            {screen.screen.filters.map((filter) => {
              const counts = screen.universe.filters.find((item) => item.id === filter.id);
              return (
                <li key={filter.id} data-active="true" title={counts ? `${counts.matches_total} matched` : undefined}><Badge tone="warn">{filter.name}</Badge></li>
              );
            })}
          </ul>
          <span className={styles.filterNote}>{filtersNote(screen.screen.filters.length)}</span>
        </div>
        {screenWarnings(screen).map((text) => (
          <p key={text} className={styles.banner} role="status">{text}</p>
        ))}
        {message && (retry ? <ErrorBlock message={message} onRetry={retry} /> : <p className={styles.banner} role="alert">{message}</p>)}

        <section className={styles.section} aria-label="Candidates">
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Candidates</h2>
          </div>
          {unscanned && rows.length === 0 ? (
            <div data-testid="not-scanned">
              <EmptyBlock title={PRACTICE_COPY.screenNoScanTitle}>
                <p className={styles.muted}>{practiceText("screenNoScanHint", { clock: formatEtDateClock(clock, { seconds: false }) })}</p>
              </EmptyBlock>
            </div>
          ) : (
            <>
              <p className={styles.muted} data-testid="open-hint">{practiceText("screenOpenHint", { time: formatEtTimeZone(clock) })}</p>
              {live && liveAt && (
                <p className={styles.muted} data-testid="live-note">
                  {practiceText(live.today ? "screenLiveNote" : beforeOpen(clock) ? "screenLiveNotePre" : "screenLiveNoteOpen", {
                    clock: formatEtDateClock(clock, { seconds: false }),
                    scan: screen.rescan ? formatEtDateTimeZone(screen.rescan.as_of) : formatEtTimeZone(screen.data_through),
                  })}
                </p>
              )}
              {/* A failed read at the clock says so and offers a retry; the columns that follow the clock stay empty until it lands, never silently dashes. */}
              {atClock.error !== null && !landed && <ErrorBlock message={PRACTICE_COPY.screenLiveError} onRetry={atClock.refresh} />}
              <DenseTable
                caption="Candidates"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.symbol}
                selectedKey={selected}
                onSelect={(row) => void practice(row.symbol)}
                scrollX
                empty={
                  <EmptyBlock title={PRACTICE_COPY.screenNoNamesTitle}>
                    <p className={styles.muted}>{PRACTICE_COPY.screenNoNamesHint}</p>
                  </EmptyBlock>
                }
                rowActions={(row) => {
                  const here = opening === row.symbol;
                  const starred = isStarred(screen.watch, row.symbol);
                  return (
                    <span className={styles.actions}>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy || closed}
                        loading={here}
                        aria-label={here ? undefined : practiceText("screenOpen", { symbol: row.symbol })}
                        onClick={() => void practice(row.symbol)}
                      >
                        {here ? practiceText("screenOpening", { symbol: row.symbol }) : PRACTICE_COPY.screenOpenButton}
                      </Button>
                      <Button size="sm" variant="primary" disabled={busy} aria-label={practiceText("screenPeekAt", { symbol: row.symbol })} onClick={() => peekAt(row.symbol)}>
                        {PRACTICE_COPY.screenPeek}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy || closed}
                        aria-pressed={starred}
                        aria-label={practiceText(starred ? "screenUnstar" : "screenStar", { symbol: row.symbol })}
                        onClick={() => void toggleStar(row.symbol)}
                      >
                        {starred ? PRACTICE_COPY.screenStarredButton : PRACTICE_COPY.screenStarButton}
                      </Button>
                    </span>
                  );
                }}
              />
              <UniverseFootnote text={universeNote(screen.universe)} />
              <UniverseFootnote text={sourceNote(screen)} />
            </>
          )}
        </section>

        {screen.watch.length > 0 && (
          <section className={styles.section} aria-label={PRACTICE_COPY.screenYourNames}>
            <h2 className={styles.sectionTitle}>{PRACTICE_COPY.screenYourNames}</h2>
            <ul className={styles.watchList} data-testid="your-names">
              {screen.watch.map((starred) => (
                <li key={starred.symbol} className={styles.watchRow}>
                  <span className={styles.symbol}>{starred.symbol}</span>
                  <Button size="sm" disabled={busy || closed} aria-label={practiceText("screenUnstar", { symbol: starred.symbol })} onClick={() => void toggleStar(starred.symbol)}>
                    {PRACTICE_COPY.screenUnstarButton}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {lanes.length > 0 && (
          <section className={styles.section} aria-label={PRACTICE_COPY.screenLanes}>
            <h2 className={styles.sectionTitle}>{PRACTICE_COPY.screenLanes}</h2>
            <ul className={styles.watchList} data-testid="screen-lanes">
              {lanes.map((lane) => (
                <li key={lane.id} className={styles.watchRow} data-symbol={lane.symbol}>
                  <Button client size="sm" href={replayHref(lane.id)} aria-label={practiceText("screenOpen", { symbol: lane.symbol })}>{lane.symbol}</Button>
                  <span className={styles.laneText}>{laneLine(lane)}{lane.behind_clock ? ` · ${PRACTICE_COPY.screenLaneBehind}` : ""}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className={styles.section} aria-label="Scan">
          <h2 className={styles.sectionTitle}>{PRACTICE_COPY.screenRescanTitle}</h2>
          <div className={styles.actions}>
            <Button disabled={busy || scanning || scanRunning || !canRescan(screen) || current || refusal !== null} onClick={() => void rescan()}>
              {scanning || scanRunning ? PRACTICE_COPY.screenRescanning : unscanned ? PRACTICE_COPY.screenScanNow : PRACTICE_COPY.screenRescanNow}
            </Button>
            {!scanRunning && refusal === null && (
              <span className={styles.muted} data-testid="rescan-hint">
                {!canRescan(screen) ? PRACTICE_COPY.screenRescanClosed : current ? PRACTICE_COPY.screenRescanCurrent : PRACTICE_COPY.screenRescanHint}
              </span>
            )}
          </div>
          {refusal !== null && (
            <div data-testid="rescan-refused">
              <Banner tone="warn" action={<Button client href={threadPageHref(threadId)}>{PRACTICE_COPY.screenToSummary}</Button>}>
                {rescanRefusedText(refusal)}
              </Banner>
            </div>
          )}
          {screen.rescan_job?.state === "running" && (
            <div className={styles.scanProgress} data-testid="rescan-progress">
              <progress
                className={styles.scanBar}
                max={Math.max(screen.rescan_job.total, 1)}
                value={screen.rescan_job.total === 0 ? undefined : screen.rescan_job.done}
                aria-label={PRACTICE_COPY.screenRescanProgressLabel}
                aria-valuetext={rescanProgressText(screen.rescan_job)}
              />
              <span className={styles.muted} data-testid="rescan-progress-text">{rescanProgressText(screen.rescan_job)}</span>
            </div>
          )}
          {screen.rescan_job?.state === "failed" && (
            <p className={styles.banner} role="alert" data-testid="rescan-failed">{screen.rescan_job.message ?? PRACTICE_COPY.screenRescanError}</p>
          )}
          {scanSeen && screen.rescan_job?.state === "done" && screen.rescan && (
            <p className={styles.muted} role="status" data-testid="rescan-done">{practiceText("screenRescanDone", { seq: screen.rescan.seq })}</p>
          )}
          {screen.rescan && (
            <>
              <p className={styles.muted} data-testid="rescan-counts">{rescanCounts(screen)}</p>
              {stale && <p className={styles.muted} role="status" data-testid="rescan-stale">{stale}</p>}
            </>
          )}
        </section>
      </div>
      {peeking && selected !== null && (
        <Dialog
          title={PRACTICE_COPY.screenPeek}
          size="drawer"
          onClose={() => setPeeking(false)}
          headerActions={<Button onClick={() => setPeeking(false)}>{PRACTICE_COPY.screenPeekClose}</Button>}
        >
          <PeekPanel
            symbol={selected}
            row={screen.candidates.find((candidate) => candidate.symbol === selected) ?? null}
            peek={peek.data?.peek ?? null}
            loading={peek.loading}
            failed={peek.data === null && peek.error !== null}
            onRetry={peek.refresh}
          />
        </Dialog>
      )}
      <RightRail
        label="Screen context"
        multi
        openIds={railOpen}
        onOpenIdsChange={setRailOpen}
        sections={[
          {
            id: "plan",
            label: PRACTICE_COPY.threadPlanTitle,
            node: (
              <>
                <FactList
                  facts={[
                    ...(screen.thread ? [{ id: "balance", label: PRACTICE_COPY.threadBalance, value: <>{formatBalance(screen.thread.balance)} <SimulatedBadge /></> }] : []),
                    { id: "chart", label: "Chart", value: screen.plan.spec.setup.interval },
                  ]}
                />
                {plan && <p className={styles.muted}>{riskPlanText(plan)}</p>}
              </>
            ),
          },
        ]}
      />
    </div>
  );
}

/**
 * The thread's time on the Screen: the line under the title, and the badge and status bar of the shell. `shown` is the Summary's own ticking clock (the same
 * poll, held when the poll fails), so the two screens agree to the second. Past the data day's tape end it says the market is closed while the time keeps counting.
 */
function ScreenClock({ day, shown, status, market }: { day: string; shown: string; status: PracticeStatusLine; market: Screen["market"] }) {
  useReportPracticeChrome({ day, playhead: shown, scope: "days", status });
  const closed = market?.phase === "closed";
  return (
    <p className={styles.muted} data-testid="day-clock">
      <span>{PRACTICE_COPY.threadTime} · </span>
      <span data-testid="day-clock-time">{formatEtDateClock(shown)}</span>
      {closed && market && <span data-testid="market-closed">{` · ${practiceText("marketClosed", { time: formatEtTimeZone(market.tape_end) })}`}</span>}
      {closed && market?.next_open_at != null && <span data-testid="market-next-open">{` · ${practiceText("marketNextOpen", { when: formatEtDateClock(market.next_open_at, { seconds: false }) })}`}</span>}
    </p>
  );
}

function columnsOf(screen: Pick<Screen, "columns" | "universe">, live: FollowState | null): DenseColumn<Candidate>[] {
  return [
    {
      key: "symbol",
      label: "Symbol",
      sortValue: (row) => row.symbol,
      // The ticker with its rescan badge is 182 px on a live scan: the cell is capped so the badge gives way, not the columns beside it (D-243). The tooltip says it whole.
      truncate: (row) => [row.symbol, row.new_since_list ? PRACTICE_COPY.screenRescanNew : null, row.held_over ? PRACTICE_COPY.screenRescanHeld : null].filter(Boolean).join(" · "),
      maxWidth: SCREEN_WIDTH_CAPS.symbol,
      render: (row) => (
        <span>
          <span className={styles.symbol}>{row.symbol}</span>
          {row.new_since_list && <Badge tone="warn" style={{ marginLeft: 6 }}>{PRACTICE_COPY.screenRescanNew}</Badge>}
          {row.held_over && <Badge tone="neutral" style={{ marginLeft: 6 }}>{PRACTICE_COPY.screenRescanHeld}</Badge>}
        </span>
      ),
    },
    // The names that say why a row is listed never drop (D-223); past the cap they ellipsize and the tooltip holds them whole (D-243).
    { key: "filters", label: "Filters", sortValue: (row) => filtersText(row), render: (row) => filtersText(row), truncate: true, maxWidth: SCREEN_WIDTH_CAPS.filters },
    ...screenColumns(screen, live).map((column): DenseColumn<Candidate> => ({
      key: column.key,
      label: column.label,
      align: column.format === "time" || column.format === "earnings" ? "left" : "right",
      // A figure is never clipped (`num`); the earnings badge is the one text that varies in width, so it is capped like the name and the filters (D-243).
      ...(column.format === "time" ? {} : column.format === "earnings" ? { truncate: (row: Candidate) => screenCellTitle(column, row) ?? screenCellText(column, row), maxWidth: SCREEN_WIDTH_CAPS.earnings } : { kind: "num" as const }),
      sortValue: column.value,
      // No name was checked (every cell a dash): the column would be a row of dashes to scroll past (D-136).
      hideWhenEmpty: column.format === "earnings",
      render: (row) => {
        // The read at the clock has not landed: the column is here, its value is on its way (D-159).
        if (live?.pending && column.live) return <Skeleton width={36} height={10} className={styles.pending} still />;
        const text = screenCellText(column, row);
        if (column.format === "earnings") {
          if (row.earnings_state === "reported") return <Badge tone="warn"><span className={styles.badgeText}>{text}</span></Badge>;
          // One spelling of no value (D-236); a name that was checked and holds no report says so in its tooltip.
          const title = screenCellTitle(column, row);
          return title ? <span title={title}>{text}</span> : text;
        }
        const tone = screenCellTone(column, row);
        return <span className={tone ? styles[tone] : undefined}>{text}</span>;
      },
    })),
  ];
}
