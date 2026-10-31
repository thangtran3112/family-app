"use client";

import { AiRatingChip } from "@/components/fundamental/shared/AiRatingChip";
import { OrdersOffNotice } from "@/components/shell/desktop/OrdersOffNotice";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { CoveredCallCandidate, CoverageRow } from "@/lib/api/fundamentalSchemas";
import { withPriorities } from "@/lib/desk/columns";
import { chainState, distinctFlags, flagText, flagsText, formatDelta, formatScore, formatYield, ivRankLine, NO_MATCH_TEXT, opportunityText } from "@/lib/desk/coveredCallsView";
import { loadCandidates } from "@/lib/desk/coveredCalls";
import { asOfLine, COPY } from "@/lib/desk/freshness";
import { formatPct } from "@/lib/desk/format";
import { formatUsdPrice } from "@/lib/desk/mask";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "../fundamental.module.css";
import local from "./coveredCalls.module.css";
import { PayoffSketch } from "./PayoffSketch";

const columns = withPriorities<DenseColumn<CoveredCallCandidate>>(
  [
    { key: "expiry", label: "Expiry", render: (c) => c.expiry },
    { key: "strike", label: "Strike", align: "right", render: (c) => formatUsdPrice(c.strike) },
    { key: "dte", label: "DTE", align: "right", render: (c) => c.dte },
    { key: "bid", label: "Bid", align: "right", render: (c) => formatUsdPrice(c.bid) },
    { key: "delta", label: "Δ", align: "right", render: (c) => formatDelta(c.delta) },
    { key: "premium_yield", label: "Premium", align: "right", render: (c) => formatYield(c.premium_yield) },
    { key: "annualized_yield", label: "Annualized", align: "right", render: (c) => <strong className={local.strong}>{formatYield(c.annualized_yield)}</strong> },
    { key: "upside_cap", label: "Upside cap", align: "right", render: (c) => formatYield(c.upside_cap) },
    { key: "return_if_called", label: "If called", align: "right", render: (c) => formatYield(c.return_if_called) },
    { key: "open_interest", label: "OI", align: "right", render: (c) => c.open_interest.toLocaleString("en-US") },
    { key: "spread_pct", label: "Spread", align: "right", render: (c) => formatPct(c.spread_pct, 1) },
    { key: "flags", label: "Flags", render: (c) => <span className={local.flagsCell} title={flagsText(c.flags)}>{flagsText(c.flags)}</span> },
    { key: "score", label: "Score", align: "right", render: (c) => formatScore(c.score) },
  ],
  "fundCandidates",
);

/** The scan result for one holding and account: the engine's top three calls, IV rank, the opportunity banner and the payoff sketch. */
export function CandidatesPanel({ row, accountName }: { row: Pick<CoverageRow, "symbol" | "account_id">; accountName: string }) {
  const query = useDeskQuery(`cc-candidates:${row.symbol}:${row.account_id}`, (signal) => loadCandidates(row.symbol, row.account_id, { signal }), { intervalMs: 60_000 });
  const data = query.data;

  if (!data) {
    return query.error !== null ? <ErrorBlock subject="covered-call scan" onRetry={query.refresh} /> : <LoadingBlock label="Loading covered calls…" height={160} />;
  }
  const state = chainState(data);
  const top = data.candidates[0];
  const banner = opportunityText(data);
  const flags = distinctFlags(data.candidates);

  return (
    <section className={styles.panel} aria-label={`${data.symbol} covered calls`} data-testid="fund-cc-candidates">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>{data.symbol} · {accountName}</h2>
        {data.ai_context && <AiRatingChip rating={data.ai_context.rating} />}
      </div>
      <div className={local.stamps}>
        <p className={styles.muted}>Stock {formatUsdPrice(data.spot)} · {asOfLine(data.spot_stamp)}</p>
        <p className={styles.muted}>Option quotes · {asOfLine(data.chain_stamp)}</p>
      </div>
      {state === "not_connected" ? (
        <p className={styles.notice} role="status" data-testid="fund-cc-notconnected">{COPY.optionQuotesNotConnected}</p>
      ) : (
        <>
          {banner && <p className={local.opportunity} role="status" data-testid="fund-cc-opportunity">{banner}</p>}
          <p className={styles.muted} data-testid="fund-cc-ivrank">{ivRankLine(data)}</p>
          {state === "no_match" ? (
            <p className={styles.notice} role="status" data-testid="fund-cc-nomatch">{NO_MATCH_TEXT}</p>
          ) : (
            <>
              <div className={local.tableBleed}>
                <DenseTable caption="Covered-call candidates" columns={columns} rows={data.candidates} rowKey={(c) => `${c.expiry}:${c.strike}`} density="compact" tight />
              </div>
              {flags.length > 0 && (
                <ul className={local.notes} aria-label="What the flags mean">
                  {flags.map((flag) => <li key={flag}>{flagText(flag)}</li>)}
                </ul>
              )}
              {top && <PayoffSketch spot={data.spot} strike={top.strike} bid={top.bid} />}
            </>
          )}
        </>
      )}
      {data.ai_context?.note && <p className={local.aiNote} style={{ color: "var(--color-ai)" }}>{data.ai_context.note}</p>}
      <div className={local.actions}>
        <button type="button" className={styles.button} disabled aria-describedby="cc-alert-note">Alert me</button>
        <span className={styles.caption} id="cc-alert-note">{COPY.alertTemplatesNotStarted}</span>
      </div>
      <OrdersOffNotice />
    </section>
  );
}
