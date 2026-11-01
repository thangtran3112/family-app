"use client";

import { AiRatingChip } from "@/components/fundamental/shared/AiRatingChip";
import { DeskAiNotStarted } from "@/components/fundamental/shared/DeskAiNotStarted";
import { Delta } from "@/components/ui/Delta";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { withPriorities } from "@/lib/desk/columns";
import { loadBrief } from "@/lib/desk/research";
import { briefNotStarted, briefRows, briefRunLine, trackRecordTiles, type BriefRowView } from "@/lib/desk/researchView";
import { formatEtDay } from "@/lib/desk/format";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "../fundamental.module.css";
import local from "./stocks.module.css";

const COLUMNS: DenseColumn<BriefRowView>[] = withPriorities<DenseColumn<BriefRowView>>(
  [
    { key: "symbol", label: "Symbol", sortValue: (row) => row.symbol, firstSort: "asc", render: (row) => <a className={styles.link} href={row.href}>{row.symbol}</a> },
    {
      key: "rating",
      label: "Desk AI",
      render: (row) => (
        <span className={local.ratingCell}>
          <AiRatingChip rating={row.rating} />
          <span className={styles.caption}>{row.change}</span>
        </span>
      ),
    },
    { key: "target", label: "Base target", align: "right", render: (row) => <span title={`Range ${row.range}`}>{row.target}</span> },
    { key: "upside_pct", label: "Upside", align: "right", sortValue: (row) => row.upsideValue, render: (row) => <Delta tone={row.upsideTone}>{row.upside}</Delta> },
    { key: "confidence", label: "Confidence", align: "right", sortValue: (row) => row.confidenceValue, render: (row) => row.confidence },
    { key: "eps_rev_30d_pct", label: "EPS rev. 30d", align: "right", sortValue: (row) => row.epsRevValue, render: (row) => <Delta tone={row.epsRevTone}>{row.epsRev30d}</Delta> },
    { key: "earnings_in_days", label: "Earnings", align: "right", sortValue: (row) => row.earningsDays, firstSort: "asc", render: (row) => row.earnings },
    { key: "stale", label: "", render: (row) => (row.stale ? <span className={styles.caption} title={row.stale}>Stale</span> : null) },
  ],
  "fundBrief",
);

/** FD7 AI daily brief (02n §b3): every stock the Desk AI analyzed after the close. Before its first run there is nothing to list, and the screen says so. */
export function StocksBrief() {
  const query = useDeskQuery("brief", (signal) => loadBrief(undefined, { signal }), { intervalMs: 5 * 60_000 });
  const brief = query.data;
  const rows = brief ? briefRows(brief) : [];
  const runLine = brief ? briefRunLine(brief.run) : null;
  const staleRows = rows.filter((row) => row.stale);

  return (
    <>
      <header className={styles.head}>
        <h1 className={styles.pageTitle}>Stocks</h1>
        {brief && <span className={styles.caption}>AI daily brief · {formatEtDay(brief.date)}</span>}
      </header>
      {brief ? (
        <div data-testid="fund-brief" className={local.stack}>
          <ul className={styles.tiles} aria-label="Desk AI track record">
            {trackRecordTiles(brief.track_record).map((tile) => (
              <li key={tile.label}>
                <StatTile label={tile.label} value={tile.value} />
              </li>
            ))}
          </ul>
          {briefNotStarted(brief) ? (
            <div data-testid="fund-brief-notstarted"><DeskAiNotStarted title="Desk AI daily brief" /></div>
          ) : (
            <Panel aria-label="AI daily brief">
              {runLine && <p className={styles.muted} data-testid="fund-brief-run">{runLine}</p>}
              <DenseTable
                caption="AI daily brief"
                columns={COLUMNS}
                rows={rows}
                rowKey={(row) => row.symbol}
                density="compact"
                tight
                empty={<EmptyBlock title="No stocks were analyzed in this run" />}
              />
              {staleRows.length > 0 && (
                <ul className={local.rangeLegend} aria-label="Stale views">
                  {staleRows.map((row) => <li key={row.symbol}>{row.symbol}: {row.stale}</li>)}
                </ul>
              )}
            </Panel>
          )}
        </div>
      ) : query.error !== null ? (
        <ErrorBlock subject="brief" onRetry={query.refresh} />
      ) : (
        <LoadingBlock label="Loading the brief…" height={200} />
      )}
    </>
  );
}
