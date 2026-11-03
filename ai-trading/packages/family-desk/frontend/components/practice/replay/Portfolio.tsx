"use client";

import { useState } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { formatEtTimeZone } from "@/lib/desk/format";
import { formatSignedUsd } from "@/lib/desk/mask";
import { loadPortfolio, openLane, placeMark } from "@/lib/desk/replay";
import { useDeskQuery, type DeskQueryResult } from "@/lib/desk/useDeskQuery";
import { exitMark } from "@/lib/replay/markInput";
import { exitKindFor } from "@/lib/replay/playView";
import type { Portfolio } from "@/lib/replay/portfolio";
import { openPnl, positionRows, positionsCountText, type PositionRow } from "@/lib/replay/positionTable";
import { problemMessage } from "@/lib/replay/setup";
import { dayResultTone } from "@/lib/replay/threadView";
import { OrderTable, PositionTable } from "./PositionTable";
import styles from "./panels.module.css";

const toneClass = (value: number): string => styles[dayResultTone(value) === "flat" ? "same" : dayResultTone(value)]!;

/** The thread's Portfolio at its clock. It follows every mark and every clock move through `revision`; `enabled` is off where there is no thread. */
export const useThreadPortfolio = (threadId: number | null, revision = 0, enabled = true): DeskQueryResult<Portfolio> =>
  useDeskQuery(`portfolio:${threadId}`, (signal) => loadPortfolio(threadId ?? 0, { signal }), { revision, enabled: enabled && threadId !== null });

/** The thread's portfolio (practice = portfolio), read like a broker's positions list: a head with the open-position count, then one table row for every
 *  name she holds right now at the thread's time `T` (any number of fills, one average cost; long is positive shares, short negative): side, shares, average
 *  cost, the price at `T`, its gain or loss, how long it has been held and the orders working on it (`PositionTable`). Jump a month ahead and the first
 *  read prices every holding at the new time. A name she exited is not a row: its result is a closed trade, which lives in Trades. The footer is the
 *  open P/L only, and below the table the working orders. SIMULATED. A ticker opens that name's chart; a held row also has Exit, which closes that
 *  name's position from wherever she is. `readOnly` (a closed thread) leaves Exit off: its positions stay open at the time it stopped. */
export function PortfolioPanel({ threadId, query, readOnly = false }: { threadId: number; query: DeskQueryResult<Portfolio>; readOnly?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (query.data === null) {
    return query.error === null ? null : <p className={styles.muted}>{PRACTICE_COPY.portfolioLoadError}</p>;
  }
  const portfolio = query.data;
  const rows = positionRows(portfolio.positions, portfolio.orders);
  const total = openPnl(rows);

  /** Exit from the row: opens the name's lane at the thread clock (which lifts it if it is behind) and books the exit there, in two calls. */
  async function exit(row: PositionRow) {
    const built = exitMark(exitKindFor(row.side));
    if (!built.ok) return;
    setBusy(row.symbol);
    setMessage(null);
    try {
      const lane = await openLane(threadId, row.symbol);
      await placeMark(lane.id, built.mark);
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
        <span className={styles.portfolioCount} data-testid="portfolio-count">{positionsCountText(rows.length)}</span>
        <SimulatedBadge />
      </div>
      {rows.length === 0 ? (
        <p className={styles.muted}>{PRACTICE_COPY.portfolioEmpty}</p>
      ) : (
        <PositionTable caption={PRACTICE_COPY.portfolioTable} rows={rows} actions={readOnly ? undefined : { busy, onExit: (row) => void exit(row) }} />
      )}
      {rows.length > 0 && (
        <p className={styles.portfolioTotal} data-testid="portfolio-total">
          <span className={styles.portfolioDay}>
            <span>{PRACTICE_COPY.portfolioTotal}</span>
            <span className={toneClass(total)}>{formatSignedUsd(total, { cents: true })}</span>
          </span>
          <span className={styles.muted}>
            {portfolio.as_of === null ? "" : query.connection === "reconnecting" ? practiceText("portfolioNotUpdated", { time: formatEtTimeZone(portfolio.as_of) }) : practiceText("portfolioAsOf", { time: formatEtTimeZone(portfolio.as_of) })}
          </span>
        </p>
      )}
      {portfolio.orders.some((order) => order.status === "working") && <OrderTable orders={portfolio.orders} />}
      {message && <p className={styles.problem} role="alert">{message}</p>}
      {rows.length > 0 && <p className={styles.muted}>{PRACTICE_COPY.portfolioPricedAt}</p>}
    </div>
  );
}
