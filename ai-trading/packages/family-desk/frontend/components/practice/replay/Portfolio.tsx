"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { formatEtTimeZone } from "@/lib/desk/format";
import { formatSignedUsd } from "@/lib/desk/mask";
import { loadDayList, placeMark, startDaySession } from "@/lib/desk/replay";
import { useDeskQuery, type DeskQueryResult } from "@/lib/desk/useDeskQuery";
import type { DayList } from "@/lib/replay/daily";
import { heldRows, openPositionsText, portfolioFooter, portfolioRows } from "@/lib/replay/dayView";
import { exitMark } from "@/lib/replay/markInput";
import { exitKindFor } from "@/lib/replay/playView";
import { dayPositionRow, type PositionRow } from "@/lib/replay/positionTable";
import { problemMessage } from "@/lib/replay/setup";
import { dayResultTone } from "@/lib/replay/threadView";
import { PositionTable } from "./PositionTable";
import styles from "./panels.module.css";

const toneClass = (value: number): string => styles[dayResultTone(value) === "flat" ? "same" : dayResultTone(value)]!;

/** The day list, read for the Portfolio. It follows every mark through `revision`; `enabled` is off where there is no day. */
export const useDayPortfolio = (dayListId: number | null, revision = 0, enabled = true): DeskQueryResult<DayList> =>
  useDeskQuery(`portfolio:${dayListId}`, (signal) => loadDayList(dayListId ?? 0, {}, { signal }), { revision, enabled: enabled && dayListId !== null });

/** The day's portfolio (practice = portfolio), read like a broker's positions list: a head with the open-position count, then one table row for every
 *  name she holds right now (any number of fills, one average cost; long is positive shares, short negative): last price, day change against the prior
 *  close, signed position, average price, value and its unrealized P/L (`PositionTable`). A name she exited is not a row: its result is a closed trade,
 *  which lives in Trades. The footer is the open P/L only. SIMULATED. Any number of names hold a
 *  position at once. A ticker opens or resumes that name's chart at the shared day clock; a held row also has Exit, which closes that name's trade
 *  from wherever she is. It lives on the Portfolio tab only: the chart view has none. */
export function PortfolioPanel({ dayListId, query }: { dayListId: number; query: DeskQueryResult<DayList> }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (query.data === null) {
    return query.error === null ? null : <p className={styles.muted}>{PRACTICE_COPY.dayLoadError}</p>;
  }
  const day = query.data;
  const rows = heldRows(portfolioRows(day));
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

  /** Exit from the row: opens the name's session at the day clock (which lifts it if it is behind) and books the exit there, the
   *  same two calls as the stop-pause toast. */
  async function exit(row: PositionRow) {
    if (row.side === null) return;
    const built = exitMark(exitKindFor(row.side));
    if (!built.ok) return;
    setBusy(row.symbol);
    setMessage(null);
    try {
      const session = await startDaySession(dayListId, row.symbol);
      await placeMark(session.id, built.mark);
      query.refresh();
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.orderError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.portfolio} data-testid="portfolio">
      <div className={styles.portfolioHead}>
        <span className={styles.portfolioCount} data-testid="portfolio-count">{openPositionsText(rows)}</span>
        <SimulatedBadge />
      </div>
      {rows.length === 0 ? (
        <p className={styles.muted}>{ended ? PRACTICE_COPY.dayPortfolioEnded : PRACTICE_COPY.dayPortfolioEmpty}</p>
      ) : (
        <PositionTable
          caption={PRACTICE_COPY.dayPortfolioTable}
          rows={rows.map(dayPositionRow)}
          actions={ended ? undefined : { busy, onOpen: (symbol) => void open(symbol), onExit: (row) => void exit(row) }}
        />
      )}
      {rows.length > 0 && (
        <p className={styles.portfolioTotal} data-testid="portfolio-total">
          <span className={styles.portfolioDay}>
            <span>{PRACTICE_COPY.dayPortfolioTotal}</span>
            <span className={toneClass(footer.total)}>{formatSignedUsd(footer.total, { cents: true })}</span>
          </span>
          <span className={styles.muted}>
            {footer.openOf} · {query.connection === "reconnecting" ? practiceText("dayPortfolioNotUpdated", { time: formatEtTimeZone(day.day_pnl.as_of) }) : footer.asOf}
          </span>
        </p>
      )}
      {message && <p className={styles.problem} role="alert">{message}</p>}
      {!ended && day.clock && <p className={styles.muted}>{practiceText("daySwitchHint", { time: formatEtTimeZone(day.clock) })}</p>}
    </div>
  );
}
