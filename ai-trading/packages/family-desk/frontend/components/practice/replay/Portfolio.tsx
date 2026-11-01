"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { formatEtTimeZone, formatPrice } from "@/lib/desk/format";
import { formatSignedUsd } from "@/lib/desk/mask";
import { loadDayList, placeMark, startDaySession } from "@/lib/desk/replay";
import { useDeskQuery, type DeskQueryResult } from "@/lib/desk/useDeskQuery";
import type { DayList } from "@/lib/replay/daily";
import { portfolioFooter, portfolioRows, positionText, stopCrossedText, type PortfolioRow } from "@/lib/replay/dayView";
import { exitMark } from "@/lib/replay/markInput";
import { exitKindFor } from "@/lib/replay/playView";
import type { OpenTrade } from "@/lib/replay/schemas";
import { problemMessage } from "@/lib/replay/setup";
import { dayResultTone } from "@/lib/replay/threadView";
import styles from "./panels.module.css";

const toneClass = (value: number): string => styles[dayResultTone(value) === "flat" ? "same" : dayResultTone(value)]!;

/** The name she is on in the replay, with its playhead and live open trade (null: she just exited). Absent on the day page. */
export type PortfolioFrom = { symbol: string; playhead: string; openTrade: OpenTrade | null };

/** The day list, read for the Portfolio. It follows every mark through `revision`; `enabled` is off where there is no day. */
export const useDayPortfolio = (dayListId: number | null, revision = 0, enabled = true): DeskQueryResult<DayList> =>
  useDeskQuery(`portfolio:${dayListId}`, (signal) => loadDayList(dayListId ?? 0, {}, { signal }), { revision, enabled: enabled && dayListId !== null });

/** The day's portfolio (practice = portfolio): a row for every name she opened, flat or holding its one open trade, with the
 *  day's P/L. SIMULATED. Up to five names hold a trade at once. A row opens or resumes that name's chart at the shared day
 *  clock; a held row also has Exit, which closes that name's trade from wherever she is. `from` and `onExitHere` exist only in
 *  the replay: the live view of the name on the chart and the workspace's own exit for it. */
export function PortfolioPanel({
  dayListId,
  query,
  from,
  onExitHere,
  onExited,
}: {
  dayListId: number;
  query: DeskQueryResult<DayList>;
  from?: PortfolioFrom;
  onExitHere?: () => void;
  /** A name's trade was closed from its row (the workspace answers a stop pause on it). */
  onExited?: (symbol: string) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (query.data === null) {
    return query.error === null ? null : <p className={styles.muted}>{PRACTICE_COPY.dayLoadError}</p>;
  }
  const day = query.data;
  const rows = portfolioRows(day, from);
  const footer = portfolioFooter(day.day_pnl);
  const ended = day.status === "ended";

  async function open(symbol: string) {
    setBusy(symbol);
    setMessage(null);
    try {
      const session = await startDaySession(dayListId, symbol);
      router.push(`/practice/replay?id=${session.id}`);
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.dayStartError));
    } finally {
      setBusy(null); // the workspace stays mounted across the switch, so the rows must come back
    }
  }

  /** Exit from the row: the name on the chart exits through the workspace; any other name opens its session at the day clock
   *  (which lifts it if it is behind) and books the exit there, the same two calls as the stop-pause toast. */
  async function exit(row: PortfolioRow) {
    if (row.side === null) return;
    if (row.current && onExitHere) {
      onExitHere();
      return;
    }
    const built = exitMark(exitKindFor(row.side));
    if (!built.ok) return;
    setBusy(row.symbol);
    setMessage(null);
    try {
      const session = await startDaySession(dayListId, row.symbol);
      await placeMark(session.id, built.mark);
      onExited?.(row.symbol);
      query.refresh();
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.markError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.portfolio} data-testid="portfolio">
      <div className={styles.portfolioHead}>
        <SimulatedBadge />
      </div>
      {rows.length === 0 ? (
        <p className={styles.muted}>{ended ? PRACTICE_COPY.reviewNoPicks : PRACTICE_COPY.dayPortfolioEmpty}</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((row) => (
            <li key={row.symbol} className={styles.portfolioItem} data-symbol={row.symbol}>
              <PortfolioRowView row={row} inert={ended} busy={busy} onOpen={() => void open(row.symbol)} onExit={() => void exit(row)} />
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <p className={styles.portfolioTotal} data-testid="portfolio-total">
          <span>{PRACTICE_COPY.dayPortfolioTotal}</span>
          <span className={toneClass(footer.total)}>{formatSignedUsd(footer.total, { cents: true })}</span>
          <span className={styles.muted}>{footer.split}</span>
          <span className={styles.muted}>{footer.openOf} · {footer.asOf}</span>
        </p>
      )}
      {message && <p className={styles.problem} role="alert">{message}</p>}
      {!ended && day.clock && <p className={styles.muted}>{practiceText("daySwitchHint", { time: formatEtTimeZone(day.clock) })}</p>}
    </div>
  );
}

function PortfolioRowView({ row, inert, busy, onOpen, onExit }: { row: PortfolioRow; inert: boolean; busy: string | null; onOpen: () => void; onExit: () => void }) {
  const body = (
    <>
      <span className={styles.portfolioLine}>
        <span className={styles.armedName}>{row.symbol}</span>
        <span className={styles.portfolioPosition}>{positionText(row)}</span>
        <span className={`${styles.portfolioPnl} ${toneClass(row.dayPnl)}`} data-testid="portfolio-row-total">{formatSignedUsd(row.dayPnl, { cents: true })}</span>
      </span>
      <span className={styles.portfolioMeta}>
        {row.position !== null && <span>{practiceText("dayPortfolioLast", { price: formatPrice(row.position.last_price) })}</span>}
        {row.unrealized !== null && <span>unrealized {formatSignedUsd(row.unrealized, { cents: true })}</span>}
        {(row.trades > 0 || row.holding) && <span>{practiceText("dayPortfolioRealized", { amount: formatSignedUsd(row.realized, { cents: true }) })}</span>}
        {row.trades > 0 && <span>{row.trades === 1 ? "1 trade" : `${row.trades} trades`}</span>}
        {row.current && <span className={styles.chip} data-tone="up">{PRACTICE_COPY.dayOnNow}</span>}
        {row.behind && <span className={styles.chip}>{PRACTICE_COPY.dayBehind}</span>}
        {row.stopHitAt !== null && <span className={styles.portfolioStop}>{stopCrossedText(row.stopHitAt)}</span>}
      </span>
    </>
  );
  if (inert) return <div className={styles.portfolioRow} data-inert="true">{body}</div>;
  const disabled = busy !== null;
  return (
    <>
      <button
        type="button"
        className={styles.portfolioRow}
        aria-current={row.current ? "true" : undefined}
        aria-disabled={!row.current && disabled ? "true" : undefined}
        aria-busy={busy === row.symbol ? "true" : undefined}
        aria-label={practiceText("daySwitch", { symbol: row.symbol })}
        onClick={() => {
          if (!row.current && !disabled) onOpen();
        }}
      >
        {body}
      </button>
      {row.holding && (
        <button type="button" className={styles.portfolioExit} disabled={disabled} aria-label={practiceText("dayPortfolioExit", { symbol: row.symbol })} onClick={onExit}>
          Exit
        </button>
      )}
    </>
  );
}
