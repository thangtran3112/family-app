"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { MarketChart, type MarketChartLevel } from "@/components/charts/MarketChart";
import { BackLink } from "@/components/practice/hub/BackLink";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText, prepPercent } from "@/lib/desk/freshness";
import { whenReady } from "@/lib/desk/patience";
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
  prepStep,
  resumeDayLabel,
  starEntry,
  trustedSwingState,
  type PrepStep,
} from "@/lib/replay/boardView";
import { isStarred, peekDailyBars, peekOffsets, toggledStars } from "@/lib/replay/dayView";
import { problemMessage } from "@/lib/replay/setup";
import { boardCellText, boardCellTone, earningsText, freeCashText, holdsOpenText, passDayPrompt, swingBoardTitle, swingDatesHidden } from "@/lib/replay/swing";
import { formatBalance } from "@/lib/replay/threadView";
import { continueSwingThread, endAnyDay, isSwingDayList, loadAnyDayList, patchAnyDayList, type BoardRow, type SwingDayList, type SwingPeek, type SwingPlan } from "@/lib/replay/swingApi";
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
 * Stars are focus names (at most 20). An ended day shows its summary instead of a review. The board keeps its own
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
  // Arriving, and after Pass has replaced the day's buttons, the keyboard starts at the page heading, not at the skip link (D-093).
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  // Answers that land after she left the board move nothing; and when the wait for the next day's data began.
  const mounted = useRef(true);
  const prepSince = useRef<number | null>(null);

  const ended = list.status === "ended";
  const threadId = list.thread?.id ?? list.plan.thread_id;
  // The thread knows the dates rule and where the calendar goes next. Until it answers, dates stay hidden.
  const thread = useDeskQuery(`swing-thread:${threadId}`, (signal) => loadThread(threadId ?? 0, { signal }), { enabled: threadId !== null });
  const hidden = swingDatesHidden(thread.data?.thread.swing);
  // Right after Pass the thread is read again; until that answer lands the old one (still on Day N) offers nothing.
  const swingState = trustedSwingState(thread);

  const peek = useDeskQuery(`swing-peek:${list.id}:${selected}`, (signal) => loadAnyDayList(list.id, { peek: selected ?? undefined }, { signal }), {
    enabled: selected !== null && !ended,
  });
  const peekData = peek.data !== null && isSwingDayList(peek.data) ? peek.data.peek : null;

  useReportPracticeChrome({ day: list.day, hidden, playhead: list.clock ?? dayOpenClock(list.day) });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Where Continue goes: to the day that opened, to the hub when there is nothing to wait for, else wait for the data. */
  function follow(step: PrepStep) {
    if (!mounted.current) return;
    if (step.kind === "open") router.push(step.href);
    else if (step.kind === "hub") router.push("/practice");
    else if (step.kind === "wait") setPrep(step.prep);
    else {
      setPrep(null);
      setMessage(PRACTICE_COPY.swingPrepTooLong);
    }
  }

  const followRef = useRef(follow);
  useEffect(() => {
    followRef.current = follow;
  });

  // The next day is still being prepared: ask again until it opens (the call is safe to repeat), for at most ten minutes.
  useEffect(() => {
    if (prep === null || threadId === null) {
      prepSince.current = null;
      return;
    }
    const since = (prepSince.current ??= Date.now());
    const timer = setTimeout(() => {
      continueSwingThread(threadId).then(
        (result) => followRef.current(prepStep(result, since, Date.now())),
        (error: unknown) => {
          if (!mounted.current) return;
          setPrep(null);
          setMessage(problemMessage(error, PRACTICE_COPY.swingContinueError));
        },
      );
    }, PREP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [prep, threadId]);

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
  // Start and Resume ask the same thing: the name's session at the day clock (a name left behind it is lifted by the server).
  const startNow = () =>
    run(async () => {
      if (start.kind === "none") return;
      const session = await startDaySession(list.id, start.symbol);
      router.push(`/practice/replay?id=${session.id}`);
    }, PRACTICE_COPY.swingStartError);

  const pass = () =>
    run(async () => {
      const answer = await whenReady(() => endAnyDay(list.id));
      if (!isSwingDayList(answer)) return;
      setList(answer);
      setConfirmPass(false);
      thread.refresh();
      requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
    }, PRACTICE_COPY.swingPassError);

  const proceed = () =>
    run(async () => {
      if (threadId === null) return;
      const now = Date.now();
      follow(prepStep(await whenReady(() => continueSwingThread(threadId)), now, now));
    }, PRACTICE_COPY.swingContinueError);

  const holdsOpen = list.holds.filter((hold) => hold.status === "open").length;
  const held = heldSides(list.holds);
  const after = ended ? endedDayView(list, swingState) : null;
  const late = lateStarsText(lateStars(list));
  const freeCash = list.free_cash_usd ?? list.thread?.free_cash_usd ?? null;

  return (
    <div className={dayStyles.screen}>
      <BackLink threadId={threadId} />
      <header className={dayStyles.header}>
        <div className={dayStyles.titleRow}>
          <h1 ref={titleRef} tabIndex={-1} className={dayStyles.title}>{swingBoardTitle(list, hidden)}</h1>
          <Badge tone="neutral">{practiceText("swingWeek", { n: list.week_no })}</Badge>
          <Badge tone="neutral">{ended ? PRACTICE_COPY.swingDayOver : PRACTICE_COPY.swingAsOfPriorClose}</Badge>
        </div>
        <div className={dayStyles.actions}>
          {!ended && (
            <Button
              variant="primary"
              disabled={busy || start.kind === "none"}
              aria-describedby={start.kind === "none" ? "swing-star-hint" : undefined}
              onClick={() => void startNow()}
            >
              {start.kind === "resume" ? resumeDayLabel(list.day_no) : practiceText("swingStartDay", { n: list.day_no })}
            </Button>
          )}
          {!ended && canPass(list) && !confirmPass && (
            <Button ref={passButton} disabled={busy} onClick={() => setConfirmPass(true)}>{PRACTICE_COPY.swingPassDay}</Button>
          )}
          {after?.next?.kind === "continue" && (
            <Button variant="primary" disabled={busy || prep !== null} onClick={() => void proceed()}>{after.next.label}</Button>
          )}
        </div>
      </header>
      <div className={styles.strip} role="group" aria-label="Practice thread">
        <span className={styles.stripMain}>
          {list.thread && <span>{practiceText("swingBalance", { amount: formatBalance(list.thread.balance) })}</span>}
          {list.thread?.equity_usd != null && <span>{practiceText("swingEquity", { amount: formatBalance(list.thread.equity_usd) })}</span>}
          <span>{freeCashText(freeCash)}</span>
          <span aria-hidden="true">·</span>
          <span>{holdsOpenText(holdsOpen)}</span>
          <SimulatedBadge />
        </span>
        {threadId !== null && <Link href={`/practice/journal?thread=${threadId}`} className={styles.stripLink}>{PRACTICE_COPY.threadJournal}</Link>}
      </div>
      <div className={dayStyles.body}>
        {/* The reason Start Day is dim sits right under the button, linked to it, not 220 px lower in the universe section (D-138). */}
        {!ended && start.kind === "none" && <p id="swing-star-hint" className={dayStyles.muted}>{PRACTICE_COPY.swingBoardStarFirst}</p>}
        {message && <p className={dayStyles.banner} role="alert">{message}</p>}
        {late && !ended && <p className={dayStyles.banner} role="status">{late}</p>}
        {confirmPass && !ended && (
          <InlineConfirm
            label="Confirm passing the day"
            layout="block"
            size="md"
            prompt={<span>{passDayPrompt({ dayNo: list.day_no, holdsOpen })}</span>}
            confirmLabel={PRACTICE_COPY.swingPassDay}
            cancelLabel={PRACTICE_COPY.dayKeepPracticing}
            busy={busy}
            returnFocus={passButton}
            onConfirm={() => void pass()}
            onCancel={() => setConfirmPass(false)}
          />
        )}
        {prep !== null && (
          <div role="status">
            <p className={dayStyles.line}>{practiceText("swingPrepWait", { done: prep.done, total: prep.total, pct: prepPercent(prep.done, prep.total) })}</p>
            <p className={dayStyles.muted}>{PRACTICE_COPY.swingPrepWaitHint}</p>
          </div>
        )}

        {ended && list.journal && <BoardSummaryStrip summary={list.journal} />}
        {after && (
          <div className={styles.after}>
            {after.notice && <p className={styles.notice} role="status">{after.notice}</p>}
            {threadId !== null && after.waiting && (
              <Button client href={`/practice/week?thread=${threadId}&week=${after.waiting.weekNo}`} variant="primary">
                {after.waiting.label}
              </Button>
            )}
            {threadId !== null && (
              <Button
                href={`/practice/week?thread=${threadId}&week=${after.reviewWeekNo}`}
                variant={after.notice && !after.waiting ? "primary" : "secondary"}
              >
                {after.reviewLabel}
              </Button>
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
          {!ended && start.kind !== "none" && <p className={dayStyles.muted}>{PRACTICE_COPY.swingBoardStarHint}</p>}
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
                          <Button size="sm" variant="primary" aria-label={practiceText("dayRemove", { symbol: entry.symbol })} onClick={() => star(entry.symbol)}>Unstar</Button>
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
    { key: "star", label: "Star", align: "center", render: (row) => <StarCell symbol={row.symbol} on={options.starred(row.symbol)} locked={options.locked} onToggle={options.onStar} /> },
    {
      key: "symbol",
      label: "Symbol",
      sortValue: (row) => boardSortValue("symbol", row),
      firstSort: "asc",
      render: (row) => (
        <span>
          <span className={dayStyles.symbol}>{row.symbol}</span>
          {options.held[row.symbol] && <Badge tone="neutral" className={styles.tag}>{options.held[row.symbol]} hold</Badge>}
        </span>
      ),
    },
    ...boardColumns(list.columns).map((column): DenseColumn<BoardRow> => ({
      key: column.key,
      label: column.label,
      align: column.align,
      firstSort: column.firstSort,
      hideWhenEmpty: column.hideWhenEmpty,
      ...(column.priority === undefined ? {} : { priority: column.priority }),
      sortValue: (row) => boardSortValue(column.key, row),
      render: (row) => {
        if (column.key === "earnings") {
          const chip = earningsText(row.earnings);
          return chip ? <Badge tone="warn">{chip}</Badge> : "—";
        }
        const tone = boardCellTone(column, row);
        const text = boardCellText(column, row);
        // A dash with no tone is plain text, so a column of dashes can be left out (hideWhenEmpty).
        return tone ? <span className={dayStyles[tone]}>{text}</span> : text;
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
  const rowLabels = useMemo(() => (hideDates ? peekOffsets(bars.length) : undefined), [bars, hideDates]);
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
      <MarketChart symbol={peek.symbol} interval="1d" bars={bars} quality="eod" asOf={null} levels={levels} volume hideDates={hideDates} rowLabels={rowLabels} chrome="bare" height={260} />
      <p className={dayStyles.muted}>{PRACTICE_COPY.swingBoardPeek}</p>
    </div>
  );
}
