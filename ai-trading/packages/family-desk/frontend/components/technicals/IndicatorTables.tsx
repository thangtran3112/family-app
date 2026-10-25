import Link from "next/link";
import type { TechnicalsSchema } from "@/lib/api/schemas";
import { formatAsOfText } from "@/lib/desk/format";
import { qualityPhrase } from "@/lib/desk/freshness";
import { indicatorName } from "@/lib/desk/labels";
import { qualityLabel } from "@/lib/labels";
import styles from "./technicals.module.css";

type Technicals = ReturnType<typeof TechnicalsSchema.parse>;

const displayNames: Record<string, string> = {
  rsi: "Relative Strength Index (14)",
  stochastic: "Stochastic (14, 3, 3)",
  stoch_rsi: "Stochastic RSI Fast (3, 3, 14, 14)",
  cci: "Commodity Channel Index (20)",
  adx: "Average Directional Index (14)",
  awesome_oscillator: "Awesome Oscillator",
  momentum: "Momentum (10)",
  macd: "MACD Level (12, 26, 9)",
  williams_r: "Williams Percent Range (14)",
  bull_bear_power: "Bull Bear Power (13)",
  ultimate_oscillator: "Ultimate Oscillator (7, 14, 28)",
  ichimoku: "Ichimoku Base (9, 26, 52)",
  vwma_20: "VWMA (20)",
  hull_ma_9: "Hull MA (9)",
};

/** "delayed-15m · 2026-10-23T19:45:00+00:00" on mobile; "Delayed 15 min · 3:45 PM ET" on desktop. */
function metaText(quality: Technicals["quality"], asOf: string | null, plain: boolean): string {
  if (plain) return `${qualityPhrase(quality)} · ${asOf ? formatAsOfText(asOf) : "time unavailable"}`;
  return `${qualityLabel(quality)} · ${asOf ?? "as of unavailable"}`;
}

function titleFor(key: string): string {
  return displayNames[key] ?? indicatorName(key);
}

function numberText(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function strategyHref(symbol: string, timeframe: string, block: string): string {
  const params = new URLSearchParams({
    template: "technical-bias-change",
    symbol,
    timeframe,
    block,
  });
  return `/strategies/new?${params.toString()}`;
}

function VoteTable({
  title,
  votes,
  symbol,
  timeframe,
  quality,
  asOf,
  plain,
}: {
  plain: boolean;
  title: string;
  votes: Record<string, { values: Record<string, number | null>; action: "Sell" | "Neutral" | "Buy" | null }>;
  symbol: string;
  timeframe: string;
  quality: Technicals["quality"];
  asOf: string | null;
}) {
  return (
    <section className={styles.tableBlock}>
      <header className={styles.blockHeader}>
        <h2>{title}</h2>
        <span className={styles.quality}>{metaText(quality, asOf, plain)}</span>
      </header>
      <div className={styles.tableScroll}>
        <table className={styles.indicatorTable}>
          <thead><tr><th scope="col">Indicator</th><th scope="col">Value</th><th scope="col">Action</th><th scope="col"><span className={styles.visuallyHidden}>Create strategy</span></th></tr></thead>
          <tbody>
            {Object.entries(votes).map(([key, vote]) => (
              <tr key={key}>
                <th scope="row">{titleFor(key)}</th>
                <td>{Object.entries(vote.values).map(([name, value]) => (
                  <span className={styles.valuePair} key={name}>{name === "value" ? "" : `${name} `}{numberText(value)}</span>
                ))}</td>
                <td><span className={vote.action ? styles[`action${vote.action.replace(" ", "")}`] : styles.unknown}>{vote.action ?? "Unavailable"}</span></td>
                <td><Link className={styles.strategyLink} href={strategyHref(symbol, timeframe, key)}>+ Strategy</Link></td>
              </tr>
            ))}
            {Object.keys(votes).length === 0 && <tr><td colSpan={4} className={styles.emptyCell}>No indicator values available.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function VolatilityBlock({ technicals, plain = false }: { technicals: Technicals; plain?: boolean }) {
  const { atr14, atr_percent: atrPercent, label } = technicals.volatility;
  return (
    <section className={styles.volatilityBlock} aria-label="Non-voting volatility">
      <header className={styles.blockHeader}>
        <h2>Volatility · no vote</h2>
        <span className={styles.quality}>{metaText(technicals.quality, technicals.as_of, plain)}</span>
      </header>
      <dl className={styles.volatilityValues}>
        <div><dt>ATR (14)</dt><dd>{numberText(atr14)}</dd></div>
        <div><dt>ATR as % of price</dt><dd>{atrPercent === null ? "—" : `${numberText(atrPercent)}%`}</dd></div>
        <div><dt>Volatility label</dt><dd>{technicals.quality === "unavailable" ? "Unavailable" : label ?? "Warming up"}</dd></div>
      </dl>
    </section>
  );
}

export function IndicatorTables({ technicals, timeframe, showPivots = true, plain = false }: { technicals: Technicals; timeframe: string; showPivots?: boolean; plain?: boolean }) {
  return (
    <div className={`${styles.tables} ${plain ? styles.tablesDense : ""}`}>
      <VolatilityBlock technicals={technicals} plain={plain} />
      <VoteTable plain={plain} title="Oscillators" votes={technicals.oscillators} symbol={technicals.symbol} timeframe={timeframe} quality={technicals.quality} asOf={technicals.as_of} />
      <VoteTable plain={plain} title="Moving averages" votes={technicals.moving_averages} symbol={technicals.symbol} timeframe={timeframe} quality={technicals.quality} asOf={technicals.as_of} />
      {showPivots && <div className={styles.pivotGrid}>
        {(["classic", "fibonacci", "camarilla"] as const).map((method) => (
          <section className={styles.tableBlock} key={method}>
            <header className={styles.blockHeader}>
              <h2>{method} pivots</h2>
              <span className={styles.quality}>{metaText(technicals.quality, technicals.as_of, plain)}</span>
            </header>
            <div className={styles.pivotList}>
              {Object.entries(technicals.pivots[method]).map(([level, value]) => (
                <div className={styles.pivotRow} key={level}><span>{level}</span><strong>{numberText(value)}</strong></div>
              ))}
              {Object.keys(technicals.pivots[method]).length === 0 && <p className={styles.emptyCell}>Prior completed period unavailable.</p>}
            </div>
          </section>
        ))}
      </div>}
    </div>
  );
}
