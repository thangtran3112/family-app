"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { withPriorities } from "@/lib/desk/columns";
import { formatClock, formatEtDay } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { endDay, loadDaily, loadDayList, loadThread, openNextDay, patchDayList, relistDay, startDaySession } from "@/lib/desk/replay";
import { openRailTab } from "@/lib/desk/rail";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { useShellBand } from "@/lib/desk/useViewportBand";
import type { Candidate, DayList } from "@/lib/replay/daily";
import {
  datesHidden,
  dayCellText,
  dayCellTone,
  dayColumns,
  dayTitle,
  filtersNote,
  filtersText,
  isStarred,
  listBuiltText,
  listCountsText,
  listWarning,
  MAX_STARS,
  noMatchText,
  sourceNote,
  toggledStars,
  universeNote,
} from "@/lib/replay/dayView";
import { problemMessage } from "@/lib/replay/setup";
import { dayStatusLine } from "@/lib/replay/statusLine";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
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
  const list = useDeskQuery(`day-list:${id}`, (signal) => loadDayList(id ?? 0, {}, { signal }), { enabled: id !== null });
  // No id: the day she has open, if any, is the one she means (a bookmark or the bare route).
  const daily = useDeskQuery("replay-daily", (signal) => loadDaily({ signal }), { enabled: id === null });
  const openDay = daily.data?.plan?.current ?? null;
  const openDayId = openDay !== null && openDay.status !== "ended" ? openDay.id : null;
  useEffect(() => {
    if (id === null && openDayId !== null) router.replace(`/practice/day?id=${openDayId}`);
  }, [id, openDayId, router]);

  if (id === null) {
    if (daily.loading || openDayId !== null) {
      return (
        <div className={styles.body}>
          <LoadingBlock label={PRACTICE_COPY.dayLoading} height={320} />
        </div>
      );
    }
    return (
      <div className={styles.body}>
        <EmptyBlock title={PRACTICE_COPY.dayNoPlan}><Link href="/practice" className={styles.link}>Open Practice</Link></EmptyBlock>
      </div>
    );
  }
  if (list.data === null) {
    return (
      <div className={styles.body}>
        {list.error === null ? <LoadingBlock label={PRACTICE_COPY.dayLoading} height={320} /> : <ErrorBlock message={PRACTICE_COPY.dayLoadError} onRetry={list.refresh} />}
      </div>
    );
  }
  return <DayList key={list.data.id} list={list.data} onChanged={list.refresh} />;
}

function DayList({ list, onChanged }: { list: DayList; onChanged: () => void }) {
  const router = useRouter();
  const ended = list.status === "ended";
  const hidden = datesHidden(list.plan.spec) && !ended;
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // At the 1180 band the right rail is a tab strip: a row click opens the Peek drawer and the others stay as they are (D-020).
  const band = useShellBand();
  const [railOpen, setRailOpen] = useState<string[]>([]);

  // The risk plan is the thread's (D-007): read it from the thread, not from the day's plan.
  const threadId = list.thread?.id ?? null;
  const thread = useDeskQuery(`day-thread:${threadId}`, (signal) => loadThread(threadId ?? 0, { signal }), { enabled: threadId !== null });

  const peek = useDeskQuery(`day-peek:${list.id}:${selected}`, (signal) => loadDayList(list.id, { peek: selected ?? undefined }, { signal }), { enabled: selected !== null });

  // The badge reads the day clock once practice has started, else the time the list was built (D-014).
  useReportPracticeChrome({ day: list.day, hidden, playhead: list.clock ?? list.list_at, scope: "days", status: dayStatusLine(list) });

  const practicing = list.sessions[0] ?? null;
  const columns = columnsOf(list, {
    starred: (symbol) => isStarred(list.watch, symbol),
    onStar: (symbol) => void star(symbol),
    locked: ended,
  });

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

  async function star(symbol: string) {
    const next = toggledStars(list.watch, symbol);
    if (next === null) {
      setMessage(PRACTICE_COPY.dayStarsFull);
      return;
    }
    await run(async () => {
      await patchDayList(list.id, { watch: next });
      onChanged();
    }, PRACTICE_COPY.dayLoadError);
  }

  const practice = (symbol: string) =>
    run(async () => {
      const session = await startDaySession(list.id, symbol);
      router.push(`/practice/replay?id=${session.id}`);
    }, PRACTICE_COPY.dayStartError);

  const finish = () =>
    run(async () => {
      await endDay(list.id);
      setConfirmEnd(false);
      onChanged();
    }, PRACTICE_COPY.dayLoadError);

  const relist = (listAt: string) =>
    run(async () => {
      const result = await relistDay(list.id, listAt);
      if (result.plan.prep.state === "running" && result.screen.list_at !== listAt) setMessage(PRACTICE_COPY.dayRelistPreparing);
      onChanged();
    }, PRACTICE_COPY.dayRelistError);

  const next = () =>
    run(async () => {
      const result = await openNextDay();
      router.push(result.day_list_id === null ? "/practice" : `/practice/day?id=${result.day_list_id}`);
    }, PRACTICE_COPY.planStartError);

  const warning = listWarning(list);
  const title = dayTitle(list, hidden);
  const setup = list.plan.spec.setup;

  return (
    <div className={styles.screen} data-drawer={band === "1180" && railOpen.length > 0 ? "open" : undefined}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{title} · Practice day list</h1>
          {hidden && <span className={styles.chip}>{PRACTICE_COPY.dayDateHidden}</span>}
        </div>
        <div className={styles.actions}>
          {practicing && !ended && (
            <Link href={`/practice/replay?id=${practicing.id}`} className={`${styles.button} ${styles.primary}`}>Resume {practicing.symbol}</Link>
          )}
          {ended ? (
            <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={() => void next()}>{PRACTICE_COPY.dayAfter}</button>
          ) : (
            <button type="button" className={styles.button} disabled={busy} onClick={() => setConfirmEnd(true)}>{PRACTICE_COPY.dayEnd}</button>
          )}
          <Link href="/practice" className={styles.button}>Practice</Link>
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
        {message && <p className={styles.banner} role="alert">{message}</p>}
        {confirmEnd && !ended && (
          <div role="group" aria-label="Confirm ending the day" className={styles.confirm}>
            <p className={styles.line}>{PRACTICE_COPY.dayEndWarning}</p>
            <div className={styles.actions}>
              <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={() => void finish()}>{PRACTICE_COPY.dayEnd}</button>
              <button type="button" className={styles.button} onClick={() => setConfirmEnd(false)}>Keep practicing</button>
            </div>
          </div>
        )}

        <section className={styles.section} aria-label="Candidates">
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Candidates</h2>
            <span className={styles.sideHint}>{practiceText("dayStarred", { n: list.watch.length, max: MAX_STARS })}</span>
          </div>
          <DenseTable
            caption="Candidates"
            columns={withPriorities(columns, "practiceList")}
            rows={list.candidates}
            rowKey={(row) => row.symbol}
            selectedKey={selected}
            onSelect={(row) => {
              setSelected(row.symbol);
              if (band === "1180") setRailOpen((open) => openRailTab(open, "peek"));
            }}
            scrollX
            empty={<EmptyBlock title={noMatchText(list)}>{PRACTICE_COPY.dayNoNames}</EmptyBlock>}
            rowActions={ended ? undefined : (row) => (
              <button
                type="button"
                className={styles.small}
                disabled={busy || (practicing !== null && practicing.symbol !== row.symbol)}
                aria-label={practiceText("dayPractice", { symbol: row.symbol })}
                onClick={() => void practice(row.symbol)}
              >
                {practicing?.symbol === row.symbol ? "Resume" : "Practice"}
              </button>
            )}
          />
          <UniverseFootnote text={universeNote(list.universe)} />
          <UniverseFootnote text={sourceNote(list)} />
        </section>

        {ended && list.review && <ReviewPanel review={list.review} journal={list.journal} footnote={list.universe.footnote} />}
        {ended && list.plan.finished && <p className={styles.muted}>{PRACTICE_COPY.dayFinished}</p>}
      </div>
      <DayLeftPanel
        list={list}
        thread={thread.data}
        selected={selected}
        onPeek={(symbol) => {
          setSelected(symbol);
          if (band === "1180") setRailOpen((open) => openRailTab(open, "peek"));
        }}
        onPractice={(symbol) => void practice(symbol)}
        onUnstar={(symbol) => void star(symbol)}
        busy={busy}
        practicing={practicing?.symbol ?? null}
        ended={ended}
      />
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
              <dl className={styles.facts}>
                {list.thread && (
                  <>
                    <div><dt>{PRACTICE_COPY.threadBalance}</dt><dd>{formatBalance(list.thread.balance)} <SimulatedBadge /></dd></div>
                    {list.thread.today_pnl_usd !== null && (
                      <div><dt>{PRACTICE_COPY.threadToday}</dt><dd className={styles[dayResultTone(list.thread.today_pnl_usd)]}>{formatDayResult(list.thread.today_pnl_usd)}</dd></div>
                    )}
                  </>
                )}
                <div><dt>Window</dt><dd>{setup.window.from}–{setup.window.to} ET</dd></div>
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

function columnsOf(
  list: DayList,
  star: { starred: (symbol: string) => boolean; onStar: (symbol: string) => void; locked: boolean },
): DenseColumn<Candidate>[] {
  return [
    {
      key: "star",
      label: "Star",
      render: (row) => {
        const on = star.starred(row.symbol);
        return (
          <button
            type="button"
            className={styles.star}
            aria-pressed={on}
            aria-label={practiceText(on ? "dayUnstar" : "dayStar", { symbol: row.symbol })}
            disabled={star.locked}
            onClick={(event) => {
              event.stopPropagation();
              star.onStar(row.symbol);
            }}
          >
            {on ? "★" : "☆"}
          </button>
        );
      },
    },
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
