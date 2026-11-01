"use client";

import Link from "next/link";
import { PortfolioPanel, useDayPortfolio } from "@/components/practice/replay/Portfolio";
import { Badge } from "@/components/ui/Badge";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, QueryBoundary } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { HUB_SWING_COPY } from "@/lib/replay/hubSwing";
import { freeCashText, holdRowView, type HoldRowView } from "@/lib/replay/swing";
import { loadHolds } from "@/lib/replay/swingApi";
import type { Thread } from "@/lib/replay/threads";
import { formatBalance } from "@/lib/replay/threadView";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";

type HoldRow = { id: string; view: HoldRowView };
const HOLD_COLUMNS: DenseColumn<HoldRow>[] = [
  { key: "symbol", label: "Symbol", render: ({ view }) => view.symbol },
  { key: "side", label: "Side", render: ({ view }) => view.side },
  { key: "shares", label: "Shares", align: "right", render: ({ view }) => view.shares },
  { key: "held", label: "Days held", render: ({ view }) => view.held },
  { key: "result", label: "Unrealized", align: "right", render: ({ view }) => <span className={o[view.resultTone]}>{view.result}</span> },
];

/**
 * The Portfolio tab of the thread page. A day thread: the names of the day that is open (each with its trade and the day's P/L,
 * Exit on a held one), the same panel the day list and the replay carry. A swing thread: its equity and free cash, and the holds
 * carried between days. With no day open a day thread has nothing to show and says where to start one. All SIMULATED.
 */
export function PortfolioTab({ summary }: { summary: Thread }) {
  const { thread, today, swing: state } = summary;
  if (thread.mode === "swing" && state) return <SwingPortfolio summary={summary} />;
  if (today === null) return <EmptyBlock title={PRACTICE_COPY.portfolioNoDay} />;
  return <DayPortfolio dayListId={today.day_list_id} />;
}

function DayPortfolio({ dayListId }: { dayListId: number }) {
  const query = useDayPortfolio(dayListId);
  return (
    <section className={styles.panel} aria-label={PRACTICE_COPY.dayPortfolio}>
      <h2 className={styles.panelTitle}>{PRACTICE_COPY.dayPortfolio}</h2>
      <QueryBoundary query={query} loading="Loading the portfolio…" height={96} message={PRACTICE_COPY.dayLoadError}>
        {() => <PortfolioPanel dayListId={dayListId} query={query} />}
      </QueryBoundary>
    </section>
  );
}

function SwingPortfolio({ summary }: { summary: Thread }) {
  const { thread, swing: state } = summary;
  // The answers follow the thread's state, so a newly ended day reads again (the journal keys them the same way).
  const stamp = `${thread.id}:${thread.status}:${state?.days_ended ?? 0}`;
  const holds = useDeskQuery(`swing-holds:${stamp}`, (signal) => loadHolds(thread.id, "open", { signal }));
  if (!state) return null;
  const tape = thread.swing?.tape ?? "off";

  return (
    <section className={`${styles.panel} ${o.tablePanel}`} aria-label={HUB_SWING_COPY.holdsTitle}>
      <div className={o.sectionHead}>
        <h2 className={styles.panelTitle}>{HUB_SWING_COPY.holdsTitle}</h2>
        <Badge tone="neutral">{practiceText("overviewHoldsCount", { n: state.holds_open })}</Badge>
      </div>
      <p className={hub.muted}>{`${practiceText("swingEquity", { amount: formatBalance(state.equity_usd) })} · ${freeCashText(state.free_cash_usd)}`}</p>
      <p className={hub.hint}>{HUB_SWING_COPY.holdsHint}</p>
      <QueryBoundary query={holds} loading="Loading the holds…" height={96} message={HUB_SWING_COPY.holdsLoadError}>
        {(data) => (
          <DenseTable
            caption={PRACTICE_COPY.overviewHoldsCaption}
            columns={HOLD_COLUMNS}
            rows={data.holds.map((hold) => ({ id: String(hold.id), view: holdRowView(hold, tape) }))}
            rowKey={(row) => row.id}
            empty={PRACTICE_COPY.swingNoHoldsOpen}
          />
        )}
      </QueryBoundary>
      <Link href={`/practice/journal?thread=${thread.id}`} className={styles.textLink}>{PRACTICE_COPY.overviewHoldsLink}</Link>
    </section>
  );
}
