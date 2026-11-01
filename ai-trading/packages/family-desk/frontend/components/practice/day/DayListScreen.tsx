"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DeskApiError } from "@/lib/api/client";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, ErrorBlock } from "@/components/ui/StateBlocks";
import { withPriorities } from "@/lib/desk/columns";
import { formatClock, formatEtDay, formatEtTimeZone } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { whenReady } from "@/lib/desk/patience";
import { endDay, loadDaily, loadDayList, loadThread, openNextDay, relistDay, rescanDay, startDaySession } from "@/lib/desk/replay";
import { openRailTab } from "@/lib/desk/rail";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { useShellBand } from "@/lib/desk/useViewportBand";
import type { Candidate, DayList, Rescan } from "@/lib/replay/daily";
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
  rescanLabel,
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
import { BackLink } from "@/components/practice/hub/BackLink";
import { PortfolioPanel, useDayPortfolio } from "@/components/practice/replay/Portfolio";
import { NewPlanModal } from "@/components/practice/hub/NewPlanModal";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { SwingBoard } from "@/components/practice/swing/SwingBoard";
import { ThreadStrip } from "@/components/practice/thread/ThreadStrip";
import { dayResultTone, formatBalance, formatDayResult, planRows } from "@/lib/replay/threadView";
import { DayLeftPanel } from "./DayLeftPanel";
import { PeekPanel } from "./PeekPanel";
import { ReviewPanel } from "./ReviewPanel";
import { UniverseFootnote } from "./UniverseFootnote";
import styles from "./day.module.css";

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
      <EmptyBlock title={title}>
        <Link href="/practice" className={styles.link}>Open Practice</Link>
      </EmptyBlock>
    </div>
  );
}

/** The day page while it loads: grey blocks where the header, the counts and the candidate rows will be (D-116). */
function DaySkeleton() {
  return (
    <div className={styles.screen} role="status" aria-busy="true" aria-label={PRACTICE_COPY.dayLoading}>
      <header className={styles.header}>
        <span className={`${styles.skel} ${styles.skelTitle}`} />
      </header>
      <div className={styles.body}>
        <span className={`${styles.skel} ${styles.skelLine}`} />
        <span className={`${styles.skel} ${styles.skelLine}`} />
        <span className={`${styles.skel} ${styles.skelTable}`} />
      </div>
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
  // The gateway cut a slow open or re-scan short and the screen is asking again; the server is still finishing (D-058, D-059).
  const [still, setStill] = useState<"open" | "rescan" | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const [scanning, setScanning] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // The plan replaced from a day with no names (D-094).
  const [changing, setChanging] = useState(false);
  // Keyboard focus follows the flow (D-092, D-093): the page heading on arrival, the confirm when it opens, the trigger when it
  // closes, and the control that replaces End day once the day has ended.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const endRef = useRef<HTMLButtonElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
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
    if (confirmEnd) yesRef.current?.focus();
  }, [confirmEnd]);
  useEffect(() => {
    if (ended && endedHere.current) {
      endedHere.current = false;
      nextRef.current?.focus({ preventScroll: true });
    }
  }, [ended]);
  const cancelEnd = () => {
    setConfirmEnd(false);
    endRef.current?.focus();
  };

  // The badge reads the day clock once practice has started, else the time the list was built (D-014).
  useReportPracticeChrome({ day: list.day, hidden, playhead: list.clock ?? list.list_at, scope: "days", status: dayStatusLine(list) });

  // The name she was last on is the one Resume opens; every name she has opened can be switched back to.
  const practicing = list.sessions.at(-1) ?? null;
  const opened = new Set(list.sessions.map((session) => session.symbol));
  const columns = columnsOf(list);
  // The portfolio re-reads whenever the day page's own data moves (a name opened, the day ended).
  const portfolioRevision = list.sessions.length * 2 + (ended ? 1 : 0);
  // One read of the day list serves the rail's Portfolio and the End-day confirm, so both name the same open trades.
  const portfolio = useDayPortfolio(list.id, portfolioRevision);
  const exits = endDayExitText(portfolioRows(portfolio.data ?? list));

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

  const finish = () =>
    run(async () => {
      await endDay(list.id);
      endedHere.current = true;
      setConfirmEnd(false);
      onChanged();
    }, PRACTICE_COPY.dayLoadError);

  const relist = (listAt: string) =>
    run(async () => {
      const result = await relistDay(list.id, listAt);
      if (result.plan.prep.state === "running" && result.screen.list_at !== listAt) setMessage(PRACTICE_COPY.dayRelistPreparing);
      onChanged();
    }, PRACTICE_COPY.dayRelistError);

  const rescan = (): Promise<void> =>
    run(
      async () => {
        setScanning(true);
        try {
          await whenReady(() => rescanDay(list.id), { onWaiting: () => setStill("rescan") });
        } finally {
          setScanning(false);
        }
        onChanged();
      },
      PRACTICE_COPY.dayRescanError,
      () => void rescan(),
    );

  // The server builds the next list before it answers, so the button says it is opening and stays disabled until the new
  // day's screen replaces this one (D-046): no second click, and no look of nothing happening.
  async function next() {
    setBusy(true);
    setMessage(null);
    setRetry(null);
    try {
      const result = await whenReady(() => openNextDay(undefined, threadId === null ? {} : { threadId }), { onWaiting: () => setStill("open") });
      router.push(result.day_list_id === null ? "/practice" : `/practice/day?id=${result.day_list_id}`);
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
      <BackLink threadId={list.thread?.id ?? list.plan.thread_id} />
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 ref={titleRef} tabIndex={-1} className={styles.title}>{title}</h1>
          <span className={styles.chip}>Practice day list</span>
          {hidden && <span className={styles.chip}>{PRACTICE_COPY.dayDateHidden}</span>}
        </div>
        <div className={`${styles.actions} ${styles.endWrap}`}>
          {practicing && !ended && (
            <Link href={`/practice/replay?id=${practicing.id}`} className={`${styles.button} ${styles.primary}`}>{resumeDayLabel(threadDayNo(list.plan, list.day_no))}</Link>
          )}
          {ended ? (
            finishHref !== null ? (
              <Link href={finishHref} className={`${styles.button} ${styles.primary}`}>{PRACTICE_COPY.dayFinishPlan}</Link>
            ) : (
              <button ref={nextRef} type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={() => void next()}>{busy ? PRACTICE_COPY.dayAfterOpening : PRACTICE_COPY.dayAfter}</button>
            )
          ) : (
            <>
              <button ref={endRef} type="button" className={styles.button} disabled={busy} aria-expanded={confirmEnd} aria-controls="day-end-confirm" onClick={() => (confirmEnd ? cancelEnd() : setConfirmEnd(true))}>{PRACTICE_COPY.dayEnd}</button>
              {confirmEnd && (
                <div
                  id="day-end-confirm"
                  role="group"
                  aria-label="Confirm ending the day"
                  className={styles.endConfirm}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") cancelEnd();
                  }}
                >
                  <p className={styles.line}>{PRACTICE_COPY.dayEndWarning}</p>
                  {exits && <p className={styles.line}>{exits}</p>}
                  <div className={styles.actions}>
                    <button ref={yesRef} type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={() => void finish()}>{PRACTICE_COPY.dayEndYes}</button>
                    <button type="button" className={styles.button} onClick={cancelEnd}>{PRACTICE_COPY.dayKeepPracticing}</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </header>
      {list.thread && <ThreadStrip thread={list.thread} />}
      <div className={styles.body}>
        <p className={styles.line}>
          {listCountsText(list)}
          <span className={styles.built}>{listBuiltText(list)}</span>
        </p>
        <div className={styles.filterRow}>
          <span className={styles.filterLabel}>{PRACTICE_COPY.planFilters}</span>
          <ul className={styles.chips} aria-label="Filters">
            {list.screen.filters.map((filter) => {
              const counts = list.universe.filters.find((item) => item.id === filter.id);
              return (
                <li key={filter.id} className={`${styles.chip} ${styles.chipOn}`} data-active="true" title={counts ? `${counts.matches_total} matched` : undefined}>{filter.name}</li>
              );
            })}
          </ul>
          <span className={styles.filterNote}>{filtersNote(list.screen.filters.length)}</span>
        </div>
        {warning && <p className={styles.banner} role="status">{warning}</p>}
        {list.relist && (
          <div className={styles.actions}>
            <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={() => void relist(list.relist!.list_at)}>{list.relist.label}</button>
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
                    {list.sessions.length === 0 && (
                      <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={() => void finish()}>{PRACTICE_COPY.daySkip}</button>
                    )}
                    {thread.data !== null && <button type="button" className={styles.button} onClick={() => setChanging(true)}>{PRACTICE_COPY.dayChangePlan}</button>}
                  </div>
                </EmptyBlock>
              }
              rowActions={(row) => {
                const here = opening === row.symbol;
                return (
                  <span className={styles.actions}>
                    <button
                      type="button"
                      className={styles.small}
                      disabled={busy}
                      aria-busy={here ? "true" : undefined}
                      aria-label={here ? undefined : practiceText(opened.has(row.symbol) ? "daySwitch" : "dayOpen", { symbol: row.symbol })}
                      onClick={() => void practice(row.symbol)}
                    >
                      {here ? practiceText("dayOpening", { symbol: row.symbol }) : nameActionLabel(opened.has(row.symbol))}
                    </button>
                    <button type="button" className={styles.small} disabled={busy} aria-label={practiceText("dayPeekAt", { symbol: row.symbol })} onClick={() => peekAt(row.symbol)}>
                      {PRACTICE_COPY.dayPeek}
                    </button>
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
                <button type="button" className={styles.button} disabled={busy || !canRescan(list)} onClick={() => void rescan()}>{scanning ? PRACTICE_COPY.dayRescanning : PRACTICE_COPY.dayRescan}</button>
                <span className={styles.muted} role={still === "rescan" ? "status" : undefined}>{still === "rescan" ? PRACTICE_COPY.dayRescanStillWorking : canRescan(list) ? PRACTICE_COPY.dayRescanHint : PRACTICE_COPY.dayRescanNeedsClock}</span>
              </div>
            )}
            {list.rescan && (
              <>
                <p className={styles.line} data-testid="rescan-label">{rescanLabel(list.rescan)}</p>
                <p className={styles.muted} data-testid="rescan-counts">{rescanCounts(list.rescan)}</p>
                {!ended && rescanStaleText(list) && <p className={styles.muted} role="status" data-testid="rescan-stale">{rescanStaleText(list)}</p>}
                <DenseTable
                  caption="Re-scan"
                  columns={withPriorities(rescanColumnsOf(list.rescan), "practiceList")}
                  rows={list.rescan.candidates}
                  rowKey={(row) => row.symbol}
                  scrollX
                  empty={<EmptyBlock title={PRACTICE_COPY.dayNoNames} />}
                />
                <UniverseFootnote text={list.rescan.universe.footnote} />
                {!ended && <p className={styles.muted}>{PRACTICE_COPY.dayRescanReadOnly}</p>}
              </>
            )}
          </section>
        )}

        {ended && list.plan.finished && <p className={styles.muted}>{PRACTICE_COPY.dayFinished}</p>}
      </div>
      <DayLeftPanel list={list} thread={thread.data} portfolio={portfolio} />
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
          // At 1440 the portfolio sits in the left rail; at 1180 that rail is a strip, so it opens from this drawer.
          ...(band === "1180" ? [{ id: "portfolio", label: PRACTICE_COPY.dayPortfolio, node: <PortfolioPanel dayListId={list.id} query={portfolio} /> }] : []),
          {
            id: "plan",
            label: list.thread ? PRACTICE_COPY.threadPlanTitle : "Plan",
            node: (
              <dl className={styles.facts}>
                {list.thread && (
                  <>
                    <div><dt>{PRACTICE_COPY.threadBalance}</dt><dd>{formatBalance(list.thread.balance)} <SimulatedBadge /></dd></div>
                    {list.thread.today_pnl_usd !== null && (
                      <div><dt>{PRACTICE_COPY.threadToday}</dt><dd className={styles[dayResultTone(list.thread.today_pnl_usd)]}>{formatDayResult(list.thread.today_pnl_usd)}</dd></div>
                    )}
                  </>
                )}
                <div><dt>Practice window</dt><dd>{practiceTime.from}–{practiceTime.to} ET</dd></div>
                <div><dt>Chart</dt><dd>{setup.interval}</dd></div>
                {thread.data?.thread.plan && planRows(thread.data.thread.plan).map((row) => <div key={row.id}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
                {ended && <div><dt>Day</dt><dd>{formatEtDay(list.day)}</dd></div>}
                {list.thread && <p className={`${styles.muted} ${styles.factsNote}`}>{PRACTICE_COPY.threadPlanFrom}</p>}
              </dl>
            ),
          },
        ]}
      />
    </div>
  );
}

/** The re-scan's table: symbol (with the new-since-list tag), the filters that matched, and the scan's own columns. Read-only: no open. */
function rescanColumnsOf(scan: Rescan): DenseColumn<Rescan["candidates"][number]>[] {
  return [
    {
      key: "symbol",
      label: "Symbol",
      render: (row) => (
        <span>
          <span className={styles.symbol}>{row.symbol}</span>
          {row.new_since_list && <span className={`${styles.chip} ${styles.chipAmber}`} style={{ marginLeft: 6 }}>{PRACTICE_COPY.dayRescanNew}</span>}
          {row.reported_before_open && <span className={`${styles.chip} ${styles.chipAmber}`} style={{ marginLeft: 6 }}>{PRACTICE_COPY.dayReported}</span>}
        </span>
      ),
    },
    { key: "filters", label: "Filters", render: (row) => filtersText(row) },
    ...scan.columns.map((column): DenseColumn<Rescan["candidates"][number]> => ({
      key: column.key,
      label: column.label,
      align: column.format === "time" ? "left" : "right",
      render: (row) => {
        const tone = cellTone(column, row);
        return <span className={tone ? styles[tone] : undefined}>{cellText(column, row)}</span>;
      },
    })),
  ];
}

function columnsOf(list: DayList): DenseColumn<Candidate>[] {
  return [
    { key: "symbol", label: "Symbol", render: (row) => <span className={styles.symbol}>{row.symbol}</span> },
    { key: "filters", label: "Filters", render: (row) => filtersText(row) },
    ...dayColumns(list).map((column): DenseColumn<Candidate> => ({
      key: column.key,
      label: column.label,
      align: column.format === "time" || column.format === "earnings" ? "left" : "right",
      render: (row) => {
        const text = dayCellText(column, row);
        if (column.format === "earnings") return text === "—" ? text : <span className={`${styles.chip} ${styles.chipAmber}`}>{text}</span>;
        if (column.missing) return <span title={PRACTICE_COPY.dayNoValue}>{text}</span>;
        const tone = dayCellTone(column, row);
        return <span className={tone ? styles[tone] : undefined}>{text}</span>;
      },
    })),
  ];
}
