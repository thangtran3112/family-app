"use client";

import { Fragment } from "react";
import { useDeskUi, useHoldings } from "@/components/shell/desktop/DeskContext";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { formatEtDay, formatPct } from "@/lib/desk/format";
import { loadCandidates, loadCoverage, loadShortCalls } from "@/lib/desk/coveredCalls";
import { callsCard, eventLines } from "@/lib/desk/holdingsView";
import { formatUsdPrice } from "@/lib/desk/mask";
import { loadResearch } from "@/lib/desk/research";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { ratingText } from "@/lib/desk/fundamentalView";
import { AiRatingChip } from "../shared/AiRatingChip";
import { DeskAiNotStarted } from "../shared/DeskAiNotStarted";
import fund from "../fundamental.module.css";
import styles from "./rail.module.css";

const PROMPT = "Select a holding to see its verdict, calls and events";

/**
 * The Fundamental right rail for one symbol (02n §b1): the Desk AI verdict card (violet), a covered-call mini card and the
 * upcoming events. Each section reads and fails on its own, so one slow source never blanks the rail.
 */
export function FundamentalRightRail({ symbol }: { symbol: string | null }) {
  const prompt = <p className={styles.prompt}>{PROMPT}</p>;
  return (
    <RightRail
      label="Selected holding"
      sections={[
        { id: "verdict", label: "Verdict", node: symbol ? <VerdictCard symbol={symbol} /> : prompt },
        { id: "calls", label: "Calls", node: symbol ? <CallsCard symbol={symbol} /> : prompt },
        { id: "events", label: "Events", node: symbol ? <EventsCard symbol={symbol} /> : prompt },
      ]}
    />
  );
}

function useResearch(symbol: string) {
  return useDeskQuery(`research:${symbol}`, (signal) => loadResearch(symbol, { signal }));
}

function VerdictCard({ symbol }: { symbol: string }) {
  const research = useResearch(symbol);
  if (research.error !== null && research.data === null) return <ErrorBlock subject="verdict" onRetry={research.refresh} />;
  if (research.data === null) return <LoadingBlock label="Loading verdict…" height={80} />;
  const verdict = research.data.verdict;
  // No verdict means the Desk AI has not run: say so, never show a rating.
  if (!verdict) return <div data-testid="fund-verdict"><DeskAiNotStarted /></div>;
  return (
    <div className={styles.verdict} data-testid="fund-verdict">
      <h3 className={fund.aiTitle}>Desk AI</h3>
      <p className={styles.line}><AiRatingChip rating={verdict.rating} /> <span className={fund.muted}>{formatPct(verdict.confidence, 0)} confidence</span></p>
      <p className={styles.line}>Target {formatUsdPrice(verdict.target.low)} – {formatUsdPrice(verdict.target.high)} · base {formatUsdPrice(verdict.target.base)}</p>
      <p className={styles.line}>{verdict.changed}</p>
      <p className={fund.muted}>{ratingText(verdict.rating)} as of {formatEtDay(verdict.as_of)}</p>
    </div>
  );
}

function CallsCard({ symbol }: { symbol: string }) {
  const { maskValues } = useDeskUi();
  const coverage = useDeskQuery("rail-coverage", (signal) => loadCoverage({ signal }));
  const shortCalls = useDeskQuery("rail-short-calls", (signal) => loadShortCalls({ signal }));
  const candidates = useDeskQuery(`rail-candidates:${symbol}`, (signal) => loadCandidates(symbol, undefined, { signal }));
  if (coverage.data === null || shortCalls.data === null) {
    return coverage.error !== null || shortCalls.error !== null
      ? <ErrorBlock subject="calls card" onRetry={() => { coverage.refresh(); shortCalls.refresh(); }} />
      : <LoadingBlock label="Loading calls…" height={80} />;
  }
  const card = callsCard(symbol, coverage.data.rows, shortCalls.data, candidates.data, maskValues);
  // A failed chain read leaves the counts and says the quotes are not there; it never invents a call.
  const note = card.note ?? (candidates.error !== null && candidates.data === null ? "Option quotes unavailable right now" : null);
  return (
    <div className={styles.block} data-testid="fund-calls">
      <dl className={styles.kv}>
        <dt>Coverable contracts</dt><dd>{card.coverable}</dd>
        <dt>Open calls</dt><dd>{card.openCalls}</dd>
      </dl>
      {card.best ? (
        <p className={styles.line}>
          Best call: <strong>{card.best.strike}</strong> · {card.best.expiry} · bid {card.best.bid} · <strong>{card.best.annualized}</strong> a year
        </p>
      ) : null}
      {note && <p className={fund.muted}>{note}</p>}
    </div>
  );
}

function EventsCard({ symbol }: { symbol: string }) {
  const { holdings } = useHoldings();
  const research = useResearch(symbol);
  const row = holdings?.rows.find((item) => item.symbol === symbol) ?? null;
  const lines = eventLines(row, research.data);
  return (
    <dl className={styles.kv} data-testid="fund-events">
      {lines.map((line) => (
        <Fragment key={line.key}>
          <dt>{line.label}</dt>
          <dd>{line.text}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
