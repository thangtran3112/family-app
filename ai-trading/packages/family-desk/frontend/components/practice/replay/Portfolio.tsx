"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { formatEtTimeZone } from "@/lib/desk/format";
import { loadDayList, startDaySession } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { portfolioRows, portfolioTotal, positionText, type PortfolioRow } from "@/lib/replay/dayView";
import { formatSignedUsd } from "@/lib/desk/mask";
import type { OpenTrade } from "@/lib/replay/schemas";
import { problemMessage } from "@/lib/replay/setup";
import { dayResultTone } from "@/lib/replay/threadView";
import styles from "./panels.module.css";

const toneClass = (value: number): string => styles[dayResultTone(value) === "flat" ? "same" : dayResultTone(value)]!;

/** The name she is on in the replay, with its playhead and live open trade (null: she just exited). Absent on the day page. */
export type PortfolioFrom = { symbol: string; playhead: string; openTrade: OpenTrade | null };

/** The day's portfolio (practice = portfolio): a row for every name she opened, flat or holding its one open trade, with
 *  the day's P/L. SIMULATED. A row opens or resumes that name's chart at the shared day clock; the server says in plain
 *  words when a trade is still open elsewhere. Reads the day list, so it follows every mark through `revision`. */
export function Portfolio({ dayListId, from, revision = 0 }: { dayListId: number; from?: PortfolioFrom; revision?: number }) {
  const router = useRouter();
  const list = useDeskQuery(`portfolio:${dayListId}`, (signal) => loadDayList(dayListId, {}, { signal }), { revision });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (list.data === null) {
    return list.error === null ? null : <p className={styles.muted}>{PRACTICE_COPY.dayLoadError}</p>;
  }
  const day = list.data;
  const rows = portfolioRows(day, from);
  const total = portfolioTotal(rows);
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
              <PortfolioRowView row={row} inert={ended} busy={busy} onOpen={() => void open(row.symbol)} />
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <p className={styles.portfolioTotal} data-testid="portfolio-total">
          <span>{PRACTICE_COPY.dayPortfolioTotal}</span>
          <span className={toneClass(total.total)}>{formatSignedUsd(total.total, { cents: true })}</span>
          <span className={styles.muted}>{practiceText("dayPortfolioSplit", { realized: formatSignedUsd(total.realized, { cents: true }), open: formatSignedUsd(total.open, { cents: true }) })}</span>
        </p>
      )}
      {message && <p className={styles.problem} role="alert">{message}</p>}
      {!ended && day.clock && <p className={styles.muted}>{practiceText("daySwitchHint", { time: formatEtTimeZone(day.clock) })}</p>}
    </div>
  );
}

function PortfolioRowView({ row, inert, busy, onOpen }: { row: PortfolioRow; inert: boolean; busy: string | null; onOpen: () => void }) {
  const blocked = row.blockedBy !== null;
  const body = (
    <>
      <span className={styles.portfolioLine}>
        <span className={styles.armedName}>{row.symbol}</span>
        <span className={styles.portfolioPosition}>{positionText(row)}</span>
        <span className={`${styles.portfolioPnl} ${toneClass(row.dayPnl)}`}>{formatSignedUsd(row.dayPnl, { cents: true })}</span>
      </span>
      <span className={styles.portfolioMeta}>
        {row.position !== null && row.unrealized !== null && <span>unrealized {formatSignedUsd(row.unrealized, { cents: true })}</span>}
        {row.trades > 0 && <span>{row.trades === 1 ? "1 trade" : `${row.trades} trades`}</span>}
        {row.current && <span className={styles.chip} data-tone="up">{PRACTICE_COPY.dayOnNow}</span>}
        {row.behind && <span className={styles.chip}>{PRACTICE_COPY.dayBehind}</span>}
        {row.holding && !row.current && <span className={styles.chip} data-tone="down">{PRACTICE_COPY.dayHolding}</span>}
        {blocked && !row.current && <span className={styles.problem}>{practiceText("dayCloseFirst", { symbol: row.blockedBy! })}</span>}
      </span>
    </>
  );
  if (inert) return <div className={styles.portfolioRow} data-inert="true">{body}</div>;
  const disabled = busy !== null || blocked;
  return (
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
  );
}
