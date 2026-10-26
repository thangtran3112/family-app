"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { MarketChart, type MarketChartLevel } from "@/components/charts/MarketChart";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadThread, startDaySession } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import {
  boardColumns,
  boardSortValue,
  boardStart,
  canPass,
  dayOpenClock,
  endedDayView,
  heldSides,
  lateStars,
  lateStarsText,
  resumeDayLabel,
  starEntry,
} from "@/lib/replay/boardView";
import { isStarred, peekDailyBars, toggledStars } from "@/lib/replay/dayView";
import { problemMessage } from "@/lib/replay/setup";
import { boardCellText, boardCellTone, earningsText, freeCashText, holdsOpenText, passDayPrompt, swingDatesHidden, swingHeaderLine } from "@/lib/replay/swing";
import { continueSwingThread, endAnyDay, isSwingDayList, loadAnyDayList, patchAnyDayList, type BoardRow, type SwingDayList, type SwingOpenNext, type SwingPeek, type SwingPlan } from "@/lib/replay/swingApi";
import dayStyles from "../day/day.module.css";
import { BoardSummaryStrip } from "./BoardSummaryStrip";
import { HoldsTable } from "./HoldsTable";
import { StarCell } from "./StarCell";
import styles from "./board.module.css";

/** How long to wait between asks while the next day's data is still being prepared. */
const PREP_WAIT_MS = 3000;

/**
 * `/practice/day?id=` for a swing thread (02p d1): the holds pinned at the top, the fixed universe as of the prior close
 * with its figures, her armed filters' matches and an earnings chip, Peek (daily bars only), and the day's buttons.
 * Stars are focus names (at most five). An ended day shows its summary instead of a review. The board keeps its own
 * copy of the day: a star shows at once and rolls back if the server refuses it, and End and Pass answer the new day.
 */
export function SwingBoard({ initial }: { initial: SwingDayList }) {
  const router = useRouter();
  const [list, setList] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmPass, setConfirmPass] = useState(false);
  const [prep, setPrep] = useState<SwingPlan["prep"] | null>(null);
  // The stars the server last confirmed (to roll back to), and which star request is the latest.
  const confirmedWatch = useRef(initial.watch);
  const latestStar = useRef(0);
  const passButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  const ended = list.status === "ended";
  const threadId = list.thread?.id ?? list.plan.thread_id;
  // The thread knows the dates rule and where the calendar goes next. Until it answers, dates stay hidden.
  const thread = useDeskQuery(`swing-thread:${threadId}`, (signal) => loadThread(threadId ?? 0, { signal }), { enabled: threadId !== null });
  const hidden = swingDatesHidden(thread.data?.thread.swing);
  const swingState = thread.data ? (thread.data.swing ?? null) : thread.error !== null ? null : undefined;

  const peek = useDeskQuery(`swing-peek:${list.id}:${selected}`, (signal) => loadAnyDayList(list.id, { peek: selected ?? undefined }, { signal }), {
    enabled: selected !== null && !ended,
  });
  const peekData = peek.data !== null && isSwingDayList(peek.data) ? peek.data.peek : null;

  useReportPracticeChrome({ day: list.day, hidden, playhead: list.clock ?? dayOpenClock(list.day) });

  useEffect(() => {
    if (confirmPass) confirmButton.current?.focus();
  }, [confirmPass]);

  // The next day is still being prepared: ask again until it opens (the call is safe to repeat).
  useEffect(() => {
    if (prep === null || threadId === null) return;
    const timer = setTimeout(() => {
      continueSwingThread(threadId).then(
        (result) => settle(router, result, setPrep),
        (error: unknown) => {
          setPrep(null);
          setMessage(problemMessage(error, PRACTICE_COPY.swingContinueError));
        },
      );
    }, PREP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [prep, threadId, router]);

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(problemMessage(error, fallback));
    } finally {
      setBusy(false);
    }
  }

  function star(symbol: string) {
    const next = toggledStars(list.watch, symbol);
    if (next === null) {
      setMessage(PRACTICE_COPY.dayStarsFull);
      return;
    }
    const request = ++latestStar.current;
    setMessage(null);
    setList((current) => ({ ...current, watch: next.map((name) => current.watch.find((item) => item.symbol === name) ?? starEntry(current, name)) }));
    patchAnyDayList(list.id, { watch: next }).then(
      (answer) => {
        if (!isSwingDayList(answer)) return;
        confirmedWatch.current = answer.watch;
        if (request === latestStar.current) setList(answer);
      },
      (error: unknown) => {
        if (request !== latestStar.current) return;
        setList((current) => ({ ...current, watch: confirmedWatch.current }));
        setMessage(problemMessage(error, PRACTICE_COPY.swingLoadError));
      },
    );
  }

  const start = boardStart(list);
  const startNow = () =>
    run(async () => {
      if (start.kind !== "start") return;
      const session = await startDaySession(list.id, start.symbol);
      router.push(`/practice/replay?id=${session.id}`);
    }, PRACTICE_COPY.swingStartError);

  const pass = () =>
    run(async () => {
      const answer = await endAnyDay(list.id);
      if (!isSwingDayList(answer)) return;
      setList(answer);
      setConfirmPass(false);
      thread.refresh();
    }, PRACTICE_COPY.swingPassError);

  const proceed = () =>
    run(async () => {
      if (threadId === null) return;
      settle(router, await continueSwingThread(threadId), setPrep);
    }, PRACTICE_COPY.swingContinueError);

  function cancelPass() {
    setConfirmPass(false);
    requestAnimationFrame(() => passButton.current?.focus());
  }

  const holdsOpen = list.holds.filter((hold) => hold.status === "open").length;
  const held = heldSides(list.holds);
  const after = ended ? endedDayView(list, swingState) : null;
  const late = lateStarsText(lateStars(list));
  const freeCash = list.free_cash_usd ?? list.thread?.free_cash_usd ?? null;

  return (
    <div className={dayStyles.screen}>
      <header className={dayStyles.header}>
        <h1 className={dayStyles.title}>{swingHeaderLine(list, hidden)}</h1>
        <div className={dayStyles.actions}>
          {!ended && start.kind === "resume" && (
            <Link href={`/practice/replay?id=${start.sessionId}`} className={`${dayStyles.button} ${dayStyles.primary}`}>{resumeDayLabel(list.day_no)}</Link>
          )}
          {!ended && start.kind !== "resume" && (
            <button
              type="button"
              className={`${dayStyles.button} ${dayStyles.primary}`}
              disabled={busy || start.kind === "none"}
              aria-describedby={start.kind === "none" ? "swing-star-hint" : undefined}
              onClick={() => void startNow()}
            >
              {practiceText("swingStartDay", { n: list.day_no })}
            </button>
          )}
          {!ended && canPass(list) && !confirmPass && (
            <button ref={passButton} type="button" className={dayStyles.button} disabled={busy} onClick={() => setConfirmPass(true)}>{PRACTICE_COPY.swingPassDay}</button>
          )}
          {after?.next?.kind === "continue" && (
            <button type="button" className={`${dayStyles.button} ${dayStyles.primary}`} disabled={busy || prep !== null} onClick={() => void proceed()}>{after.next.label}</button>
          )}
          <Link href="/practice" className={dayStyles.button}>Practice</Link>
        </div>
      </header>
      <div className={styles.strip} role="group" aria-label="Practice thread">
        <span className={styles.stripMain}>
          <span>{freeCashText(freeCash)}</span>
          <span aria-hidden="true">·</span>
          <span>{holdsOpenText(holdsOpen)}</span>
          <SimulatedBadge />
        </span>
        {threadId !== null && <Link href={`/practice/journal?thread=${threadId}`} className={styles.stripLink}>{PRACTICE_COPY.threadJournal}</Link>}
      </div>
      <div className={dayStyles.body}>
        {message && <p className={dayStyles.banner} role="alert">{message}</p>}
        {late && !ended && <p className={dayStyles.banner} role="status">{late}</p>}
        {confirmPass && !ended && (
          <div role="group" aria-label="Confirm passing the day" className={dayStyles.confirm}>
            <p className={dayStyles.line}>{passDayPrompt({ dayNo: list.day_no, holdsOpen })}</p>
            <div className={dayStyles.actions}>
              <button ref={confirmButton} type="button" className={`${dayStyles.button} ${dayStyles.primary}`} disabled={busy} onClick={() => void pass()}>{PRACTICE_COPY.swingPassDay}</button>
              <button type="button" className={dayStyles.button} onClick={cancelPass}>Keep practising</button>
            </div>
          </div>
        )}
        {prep !== null && (
          <div role="status">
            <p className={dayStyles.line}>{practiceText("swingPrepWait", { done: prep.done, total: prep.total })}</p>
            <p className={dayStyles.muted}>{PRACTICE_COPY.swingPrepWaitHint}</p>
          </div>
        )}

        {ended && list.journal && <BoardSummaryStrip summary={list.journal} />}
        {after && (
          <div className={styles.after}>
            {after.notice && <p className={styles.notice} role="status">{after.notice}</p>}
            {threadId !== null && (
              <Link
                href={`/practice/week?thread=${threadId}&week=${after.reviewWeekNo}`}
                className={after.notice ? `${dayStyles.button} ${dayStyles.primary}` : dayStyles.button}
              >
                {after.reviewLabel}
              </Link>
            )}
            {after.next?.kind === "finished" && <p className={dayStyles.muted}>{after.next.text}</p>}
          </div>
        )}

        <section className={dayStyles.section} aria-label="Practice holds">
          <h2 className={dayStyles.sectionTitle}>{PRACTICE_COPY.swingBoardHolds}</h2>
          <HoldsTable
            holds={list.holds}
            tape={thread.data?.thread.swing?.tape === "off" ? "off" : "on"}
            selectedSymbol={selected}
            onSelect={ended ? undefined : setSelected}
          />
        </section>

        <section className={dayStyles.section} aria-label="Universe">
          <h2 className={dayStyles.sectionTitle}>{PRACTICE_COPY.swingBoardUniverse}</h2>
          {!ended && <p id="swing-star-hint" className={dayStyles.muted}>{PRACTICE_COPY.swingBoardStarHint}</p>}
          <UniverseTable list={list} held={held} locked={ended} selected={selected} onSelect={setSelected} onStar={star} />
          <p className={dayStyles.footnote}>{list.label}</p>
          <p className={dayStyles.footnote}>{list.universe.footnote}</p>
        </section>

        {!ended && (
          <section className={dayStyles.section} aria-label="Peek">
            <h2 className={dayStyles.sectionTitle}>{PRACTICE_COPY.dayPeek}</h2>
            <BoardPeek symbol={selected} peek={peekData} loading={peek.loading} failed={peek.data === null && peek.error !== null} onRetry={peek.refresh} hideDates={hidden} />
          </section>
        )}
      </div>
      <RightRail
        label="Day context"
        sections={[
          {
            id: "watch",
            label: PRACTICE_COPY.dayWatch,
            node: (
              <div className={dayStyles.rail}>
                {list.watch.length === 0 ? (
                  <p className={dayStyles.muted}>{PRACTICE_COPY.dayWatchEmpty}</p>
                ) : (
                  <ul className={dayStyles.watchList}>
                    {list.watch.map((entry) => (
                      <li key={entry.symbol} className={dayStyles.watchRow}>
                        <span className={dayStyles.symbol}>{entry.symbol}</span>
                        {!ended && (
                          <button type="button" className={dayStyles.small} aria-label={practiceText("dayRemove", { symbol: entry.symbol })} onClick={() => star(entry.symbol)}>Unstar</button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

/** Where Continue goes: to the day that opened, to the hub when there is nothing to wait for, else wait for the data. */
function settle(router: ReturnType<typeof useRouter>, result: SwingOpenNext, setPrep: (prep: SwingPlan["prep"]) => void) {
  if (result.day_list_id !== null) router.push(`/practice/day?id=${result.day_list_id}`);
  else if (result.plan.finished || result.plan.prep.state !== "running") router.push("/practice");
  else setPrep(result.plan.prep);
}

function UniverseTable({
  list,
  held,
  locked,
  selected,
  onSelect,
  onStar,
}: {
  list: SwingDayList;
  held: Record<string, string>;
  locked: boolean;
  selected: string | null;
  onSelect: (symbol: string) => void;
  onStar: (symbol: string) => void;
}) {
  const columns = boardColumnsOf(list, { held, locked, starred: (symbol) => isStarred(list.watch, symbol), onStar });
  return (
    <DenseTable
      caption="Universe"
      columns={columns}
      rows={list.candidates}
      rowKey={(row) => row.symbol}
      selectedKey={selected}
      onSelect={(row) => onSelect(row.symbol)}
      scrollX
      empty={<EmptyBlock title={PRACTICE_COPY.swingLoadError} />}
    />
  );
}

function boardColumnsOf(
  list: Pick<SwingDayList, "columns">,
  options: { held: Record<string, string>; locked: boolean; starred: (symbol: string) => boolean; onStar: (symbol: string) => void },
): DenseColumn<BoardRow>[] {
  return [
    { key: "star", label: "Star", render: (row) => <StarCell symbol={row.symbol} on={options.starred(row.symbol)} locked={options.locked} onToggle={options.onStar} /> },
    {
      key: "symbol",
      label: "Symbol",
      sortValue: (row) => boardSortValue("symbol", row),
      firstSort: "asc",
      render: (row) => (
        <span>
          <span className={dayStyles.symbol}>{row.symbol}</span>
          {options.held[row.symbol] && <span className={`${styles.chip} ${styles.tag}`}>{options.held[row.symbol]} hold</span>}
        </span>
      ),
    },
    ...boardColumns(list.columns).map((column): DenseColumn<BoardRow> => ({
      key: column.key,
      label: column.label,
      align: column.align,
      firstSort: column.firstSort,
      ...(column.priority === undefined ? {} : { priority: column.priority }),
      sortValue: (row) => boardSortValue(column.key, row),
      render: (row) => {
        if (column.key === "earnings") {
          const chip = earningsText(row.earnings);
          return chip ? <span className={`${styles.chip} ${styles.chipAmber}`}>{chip}</span> : "—";
        }
        const tone = boardCellTone(column, row);
        return <span className={tone ? dayStyles[tone] : undefined}>{boardCellText(column, row)}</span>;
      },
    })),
  ];
}

const PEEK_LEVELS = ["prior_close", "prior_high", "prior_low"] as const;
const LEVEL_LABELS: Record<(typeof PEEK_LEVELS)[number], string> = { prior_close: "Prior close", prior_high: "Prior high", prior_low: "Prior low" };

/** Peek on the swing board: the daily chart of the picked name through the prior close, never a minute of the day. */
function BoardPeek({
  symbol,
  peek,
  loading,
  failed,
  onRetry,
  hideDates,
}: {
  symbol: string | null;
  peek: SwingPeek | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  hideDates: boolean;
}) {
  const bars = useMemo(() => (peek ? peekDailyBars(peek.daily, hideDates) : []), [peek, hideDates]);
  const levels = useMemo<MarketChartLevel[]>(
    () => (peek ? PEEK_LEVELS.map((key) => ({ label: LEVEL_LABELS[key], price: peek.levels[key] ?? null, style: "dotted" as const })) : []),
    [peek],
  );
  if (symbol === null) return <p className={dayStyles.muted}>{PRACTICE_COPY.dayPeekNone}</p>;
  if (failed) return <ErrorBlock subject="chart" onRetry={onRetry} />;
  if (loading || peek === null) return <LoadingBlock label={`Loading the ${symbol} chart…`} height={240} />;
  return (
    <div className={dayStyles.peek}>
      <h3 className={dayStyles.peekTitle}>{peek.symbol}</h3>
      <MarketChart symbol={peek.symbol} interval="1d" bars={bars} quality="eod" asOf={null} levels={levels} volume hideDates={hideDates} chrome="bare" height={260} />
      <p className={dayStyles.muted}>{PRACTICE_COPY.swingBoardPeek}</p>
    </div>
  );
}
