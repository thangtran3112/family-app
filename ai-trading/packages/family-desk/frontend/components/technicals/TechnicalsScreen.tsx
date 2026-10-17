"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { deskFetch } from "@/lib/api/client";
import { BarsSchema, TechnicalsSchema } from "@/lib/api/schemas";
import { qualityLabel } from "@/lib/labels";
import { loadTechnicalData, shouldStartTechnicalLoad } from "@/lib/technicals/load";
import { Gauges } from "./Gauges";
import { IndicatorTables } from "./IndicatorTables";
import { RsiMacdChart } from "./RsiMacdChart";
import styles from "./technicals.module.css";

const timeframes = ["5m", "15m", "30m", "1h", "4h", "1D", "1W"] as const;
type Timeframe = typeof timeframes[number];
const apiTimeframe: Record<Timeframe, string> = {
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "4h": "4h",
  "1D": "1d",
  "1W": "1w",
};

function timeframeFromQuery(value: string | null): Timeframe {
  const match = timeframes.find((timeframe) => timeframe.toLowerCase() === value?.toLowerCase());
  return match ?? "15m";
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

export function TechnicalsScreen() {
  const searchParams = useSearchParams();
  const routeSymbol = normalizeSymbol(searchParams.get("symbol") ?? "AAPL") || "AAPL";
  const routeTimeframe = timeframeFromQuery(searchParams.get("timeframe"));
  return <TechnicalsContent key={`${routeSymbol}:${routeTimeframe}`} symbol={routeSymbol} timeframe={routeTimeframe} />;
}

function TechnicalsContent({ symbol, timeframe }: { symbol: string; timeframe: Timeframe }) {
  const router = useRouter();
  const symbolInput = useRef<HTMLInputElement>(null);
  const [bars, setBars] = useState<ReturnType<typeof BarsSchema.parse> | null>(null);
  const [technicals, setTechnicals] = useState<ReturnType<typeof TechnicalsSchema.parse> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    return loadTechnicalData(symbol, apiTimeframe[timeframe], {
      bars: (path) => deskFetch(path, BarsSchema),
      technicals: (path) => deskFetch(path, TechnicalsSchema),
    });
  }, [symbol, timeframe]);

  useEffect(() => {
    let active = true;
    void load().then(({ bars: barResponse, technicals: technicalsResponse }) => {
      if (!active) return;
      setBars(barResponse);
      setTechnicals(technicalsResponse);
    }).catch(() => {
      if (active) setError(`Could not load technicals for ${symbol}. Check symbol and data availability, then retry.`);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [load, symbol]);

  function submitSymbol(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = normalizeSymbol(symbolInput.current?.value ?? "");
    if (!next) return;
    if (!shouldStartTechnicalLoad({ symbol, timeframe }, { symbol: next, timeframe })) return;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ symbol: next, timeframe: apiTimeframe[timeframe] });
    router.replace(`/technicals?${params.toString()}`);
  }

  function selectTimeframe(next: Timeframe) {
    if (!shouldStartTechnicalLoad({ symbol, timeframe }, { symbol, timeframe: next })) return;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ symbol, timeframe: apiTimeframe[next] });
    router.replace(`/technicals?${params.toString()}`);
  }

  function retry() {
    setLoading(true);
    setError("");
    void load().then(({ bars: barResponse, technicals: technicalsResponse }) => {
      setBars(barResponse);
      setTechnicals(technicalsResponse);
    }).catch(() => setError(`Could not load technicals for ${symbol}. Check symbol and data availability, then retry.`)).finally(() => setLoading(false));
  }

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>MARKET ANALYSIS · CLOSED BARS</p>
          <h1>Technicals</h1>
          <p className={styles.subtitle}>Desk Technical Bias · published indicator values and prior-period levels</p>
        </div>
        <form className={styles.symbolForm} onSubmit={submitSymbol}>
          <label htmlFor="technicals-symbol">Symbol</label>
          <input key={symbol} ref={symbolInput} id="technicals-symbol" autoCapitalize="characters" defaultValue={symbol} placeholder="AAPL or /ES" />
          <button type="submit">Load</button>
        </form>
      </header>

      <div className={styles.instrumentLine}>
        <strong>{symbol}</strong>
        <span>{technicals ? qualityLabel(technicals.quality) : "Market data status pending"}</span>
        <span>{technicals?.as_of ? `Source bar · ${technicals.as_of}` : "No source bar"}</span>
      </div>

      <nav className={styles.timeframes} aria-label="Technicals timeframe">
        {timeframes.map((option) => (
          <button key={option} type="button" aria-pressed={timeframe === option} onClick={() => selectTimeframe(option)}>{option}</button>
        ))}
      </nav>

      {loading && <p className={styles.feedback} role="status">Loading actual closed bars and backend technicals…</p>}
      {error && <div className={styles.error} role="alert">{error}<button type="button" onClick={retry}>Try again</button></div>}
      {!loading && !error && bars && technicals && <>
        <Gauges technicals={technicals} />
        <RsiMacdChart bars={bars} technicals={technicals} interval={apiTimeframe[timeframe]} />
        <IndicatorTables technicals={technicals} timeframe={apiTimeframe[timeframe]} />
        <details className={styles.methodNote}>
          <summary>How Desk Technical Bias is computed</summary>
          <p>Each voting indicator follows the Desk&apos;s published TradingView-based rule. Oscillator votes and moving-average votes are averaged separately; the summary is their mean. Values without enough history remain unavailable and do not vote. Closed bars only. Not a recommendation.</p>
        </details>
      </>}
    </main>
  );
}
