"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { withPriorities } from "@/lib/desk/columns";
import { formatEtDay } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { endDay, loadDaily, loadDayList, loadThread, openNextDay, patchDayList, startDaySession } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import type { Candidate, DayList } from "@/lib/replay/daily";
import { cellText, cellTone, datesHidden, dayTitle, filtersText, isStarred, listHeaderText, listWarning, nameCap, namesTodayText, starsFullText, stripRows, toggledStars } from "@/lib/replay/dayView";
import { problemMessage } from "@/lib/replay/setup";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { ThreadStrip } from "@/components/practice/thread/ThreadStrip";
import { dayResultTone, formatBalance, formatDayResult, planRows } from "@/lib/replay/threadView";
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

  // The risk plan is the thread's (D-007): read it from the thread, not from the day's plan.
  const threadId = list.thread?.id ?? null;
  const thread = useDeskQuery(`day-thread:${threadId}`, (signal) => loadThread(threadId ?? 0, { signal }), { enabled: threadId !== null });

  const peek = useDeskQuery(`day-peek:${list.id}:${selected}`, (signal) => loadDayList(list.id, { peek: selected ?? undefined }, { signal }), { enabled: selected !== null });

  // The badge reads the day clock once practice has started, else the time the list's data stops.
  useReportPracticeChrome({ day: list.day, hidden, playhead: list.clock ?? list.data_through });

  // The name she was last on is the one Resume opens; every name she has opened can be switched back to.
  const practising = list.sessions.at(-1) ?? null;
  const opened = new Map(list.sessions.map((session) => [session.symbol, session]));
  const cap = nameCap(list.plan);
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
    const next = toggledStars(list.watch, symbol, cap);
    if (next === null) {
      setMessage(starsFullText(cap));
      return;
    }
    await run(async () => {
      await patchDayList(list.id, { watch: next });
      onChanged();
    }, PRACTICE_COPY.dayLoadError);
  }

  const practise = (symbol: string) =>
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

  const next = () =>
    run(async () => {
      const result = await openNextDay();
      router.push(result.day_list_id === null ? "/practice" : `/practice/day?id=${result.day_list_id}`);
    }, PRACTICE_COPY.planStartError);

  const warning = listWarning(list);
  const title = dayTitle(list, hidden);
  const setup = list.plan.spec.setup;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title} · Practice day list</h1>
        <div className={styles.actions}>
          {practising && !ended && (
            <Link href={`/practice/replay?id=${practising.id}`} className={`${styles.button} ${styles.primary}`}>Resume {practising.symbol}</Link>
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
        <p className={styles.line}>{listHeaderText(list)}</p>
        <ul className={styles.chips} aria-label="Filters">
          {list.screen.filters.map((filter) => <li key={filter.id} className={styles.chip}>{filter.name}</li>)}
        </ul>
        {warning && <p className={styles.banner} role="status">{warning}</p>}
        {message && <p className={styles.banner} role="alert">{message}</p>}
        {confirmEnd && !ended && (
          <div role="group" aria-label="Confirm ending the day" className={styles.confirm}>
            <p className={styles.line}>{PRACTICE_COPY.dayEndWarning}</p>
            <div className={styles.actions}>
              <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={() => void finish()}>{PRACTICE_COPY.dayEnd}</button>
              <button type="button" className={styles.button} onClick={() => setConfirmEnd(false)}>Keep practising</button>
            </div>
          </div>
        )}

        <section className={styles.section} aria-label="Candidates">
          <h2 className={styles.sectionTitle}>Candidates</h2>
          {!ended && <p className={styles.muted} data-testid="names-today">{namesTodayText(list)}</p>}
          <DenseTable
            caption="Candidates"
            columns={withPriorities(columns, "practiceList")}
            rows={list.candidates}
            rowKey={(row) => row.symbol}
            selectedKey={selected}
            onSelect={(row) => setSelected(row.symbol)}
            scrollX
            empty={<EmptyBlock title={PRACTICE_COPY.dayNoNames} />}
            rowActions={ended ? undefined : (row) => (
              <button
                type="button"
                className={styles.small}
                disabled={busy}
                aria-label={practiceText("dayPractise", { symbol: row.symbol })}
                onClick={() => void practise(row.symbol)}
              >
                {opened.has(row.symbol) ? "Resume" : "Practise"}
              </button>
            )}
          />
          <UniverseFootnote text={list.universe.footnote} />
        </section>

        {!ended && (
          <section className={styles.section} aria-label="Peek">
            <h2 className={styles.sectionTitle}>{PRACTICE_COPY.dayPeek}</h2>
            <PeekPanel
              symbol={selected}
              peek={peek.data?.peek ?? null}
              loading={peek.loading}
              failed={peek.data === null && peek.error !== null}
              onRetry={peek.refresh}
              hideDates={datesHidden(list.plan.spec)}
            />
          </section>
        )}

        {ended && list.review && <ReviewPanel review={list.review} journal={list.journal} footnote={list.universe.footnote} />}
        {ended && list.plan.finished && <p className={styles.muted}>{PRACTICE_COPY.dayFinished}</p>}
      </div>
      <RightRail
        label="Day context"
        sections={[
          {
            id: "watch",
            label: PRACTICE_COPY.dayWatch,
            node: (
              <div className={styles.rail}>
                {list.watch.length === 0 ? (
                  <p className={styles.muted}>{PRACTICE_COPY.dayWatchEmpty}</p>
                ) : (
                  <ul className={styles.watchList}>
                    {list.watch.map((entry) => (
                      <li key={entry.symbol} className={styles.watchRow}>
                        <span className={styles.symbol}>{entry.symbol}</span>
                        {!ended && (
                          <span className={styles.actions}>
                            <button type="button" className={styles.small} disabled={busy} aria-label={practiceText("dayPractise", { symbol: entry.symbol })} onClick={() => void practise(entry.symbol)}>
                              {opened.has(entry.symbol) ? "Resume" : "Practise"}
                            </button>
                            <button type="button" className={styles.small} disabled={busy} aria-label={practiceText("dayRemove", { symbol: entry.symbol })} onClick={() => void star(entry.symbol)}>Unstar</button>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {!ended && <p className={styles.muted}>{PRACTICE_COPY.dayPractiseHint}</p>}

              </div>
            ),
          },
          ...(list.sessions.length > 0
            ? [
                {
                  id: "names",
                  label: PRACTICE_COPY.dayNamesTitle,
                  node: (
                    <ul className={styles.watchList} aria-label={PRACTICE_COPY.dayNamesTitle}>
                      {stripRows(list).map((row) => (
                        <li key={row.symbol} className={styles.watchRow} data-symbol={row.symbol}>
                          <span className={styles.symbol}>{row.symbol}</span>
                          <span className={styles.actions}>
                            {row.holding && <span className={`${styles.chip} ${styles.chipAmber}`}>{PRACTICE_COPY.dayHolding}</span>}
                            {row.behind && <span className={styles.chip}>{PRACTICE_COPY.dayBehind}</span>}
                            {row.sessionId !== null && !ended && (
                              <Link href={`/practice/replay?id=${row.sessionId}`} className={styles.small} aria-label={practiceText("daySwitch", { symbol: row.symbol })}>Open</Link>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ),
                },
              ]
            : []),
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
    {
      key: "symbol",
      label: "Symbol",
      render: (row) => (
        <span>
          <span className={styles.symbol}>{row.symbol}</span>
          {row.reported_before_open && <span className={`${styles.chip} ${styles.chipAmber}`} style={{ marginLeft: 6 }}>{PRACTICE_COPY.dayReported}</span>}
        </span>
      ),
    },
    { key: "filters", label: "Filters", render: (row) => filtersText(row) },
    ...list.columns.map((column): DenseColumn<Candidate> => ({
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
