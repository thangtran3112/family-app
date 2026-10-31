"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MarketChart, type MarketChartLevel } from "@/components/charts/MarketChart";
import { BiasGauge } from "@/components/technicals/Gauges";
import { BarsSchema, FuturesSpecsSchema, TechnicalsSchema } from "@/lib/api/schemas";
import { deskFetch } from "@/lib/api/client";
import { formatAsOfText } from "@/lib/desk/format";
import { qualityPhrase } from "@/lib/desk/freshness";
import { loadFuturesSnapshot, snapshotForContract, type FuturesSnapshot } from "@/lib/futures/load";
import { sizeMicroFirst } from "@/lib/futures/specs";
import styles from "./futures.module.css";

type FuturesSpec = ReturnType<typeof FuturesSpecsSchema.parse>[number];
type FuturePair = { mini: FuturesSpec; micro: FuturesSpec };
type Bars = ReturnType<typeof BarsSchema.parse>;
type Technicals = ReturnType<typeof TechnicalsSchema.parse>;

function pairsFromSpecs(specs: FuturesSpec[]): FuturePair[] {
  return specs.flatMap((mini) => {
    if (mini.root !== mini.mini || mini.mini === mini.micro) return [];
    const micro = specs.find((item) => item.root === mini.micro);
    return micro ? [{ mini, micro }] : [];
  });
}

function dollars(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "unavailable" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function classicLevels(technicals: Technicals | null): MarketChartLevel[] {
  if (!technicals || technicals.quality === "unavailable") return [];
  return Object.entries(technicals.pivots.classic).map(([label, price]) => ({
    label: `Weekly pivot ${label}`,
    price,
    color: label === "P" ? "#FFB020" : "#9B9BA1",
  }));
}

export function FuturesSwingScreen() {
  const [specs, setSpecs] = useState<FuturesSpec[] | null>(null);
  const [specError, setSpecError] = useState("");
  const [selectedRoot, setSelectedRoot] = useState("ES");
  const [selectedContract, setSelectedContract] = useState("MES");
  const [snapshot, setSnapshot] = useState<FuturesSnapshot<Bars, Technicals> | null>(null);
  const [marketError, setMarketError] = useState("");
  const [marketLoading, setMarketLoading] = useState(true);
  const [risk, setRisk] = useState("");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");

  useEffect(() => {
    let active = true;
    void deskFetch("/api/desk/futures/specs", FuturesSpecsSchema).then((result) => {
      if (active) {
        setSpecs(result);
        if (result.length === 0) setMarketLoading(false);
      }
    }).catch(() => {
      if (active) {
        setSpecError("Contract specs are unavailable.");
        setMarketLoading(false);
      }
    });
    return () => { active = false; };
  }, []);

  const pairs = useMemo(() => pairsFromSpecs(specs ?? []), [specs]);
  const pair = pairs.find(({ mini }) => mini.root === selectedRoot) ?? pairs[0];
  const activeSpec = specs?.find(({ root }) => root === selectedContract) ?? null;
  const microSpec = pair?.micro ?? null;
  const symbol = `/${selectedContract}`;
  const currentSnapshot = snapshotForContract(snapshot, symbol);
  const bars = currentSnapshot?.bars ?? null;
  const daily = currentSnapshot?.daily ?? null;
  const fourHour = currentSnapshot?.fourHour ?? null;

  useEffect(() => {
    if (!specs || !activeSpec) return;
    let active = true;
    void loadFuturesSnapshot(activeSpec.root,
      (path) => deskFetch(path, BarsSchema),
      (path) => deskFetch(path, TechnicalsSchema),
    ).then((result) => {
      if (!active) return;
      setSnapshot(result);
    }).catch(() => {
      if (active) {
        setSnapshot(null);
        setMarketError("Futures market data is unavailable for this contract.");
      }
    }).finally(() => { if (active) setMarketLoading(false); });
    return () => { active = false; };
  }, [specs, activeSpec]);

  function choosePair(next: FuturePair) {
    if (next.mini.root === selectedRoot && selectedContract === next.micro.root) return;
    setMarketLoading(true);
    setMarketError("");
    setRisk("");
    setEntry("");
    setStop("");
    setSelectedRoot(next.mini.root);
    setSelectedContract(next.micro.root);
  }

  function chooseContract(contract: FuturesSpec) {
    if (contract.root === selectedContract) return;
    setMarketLoading(true);
    setMarketError("");
    setRisk("");
    setEntry("");
    setStop("");
    setSelectedContract(contract.root);
  }

  const canSize = risk !== "" && entry !== "" && stop !== "" && microSpec !== null && pair !== undefined;
  const sizing = canSize
    ? sizeMicroFirst(Number(risk), Number(entry), Number(stop), microSpec.multiplier, pair.mini.multiplier)
    : null;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>FUTURES · SWING</p>
          <h1>Futures swing</h1>
          <p className={styles.subtitle}>CME contract specs and Desk technicals · no broker connected yet</p>
        </div>
        <Link className={styles.secondaryLink} href="/futures/specs">Specs &amp; roll calendar</Link>
      </header>

      <section className={styles.pairSection} aria-label="Futures contract pairs">
        {specError && <p className={styles.error} role="alert">{specError}</p>}
        {!specs && !specError && <p className={styles.muted} role="status">Loading futures specs…</p>}
        <div className={styles.pairGrid}>
          {pairs.map((item) => (
            <button
              key={item.mini.root}
              type="button"
              aria-pressed={pair?.mini.root === item.mini.root}
              className={styles.pairCard}
              onClick={() => choosePair(item)}
            >
              <strong>{item.mini.root} / {item.micro.root}</strong>
              <span>Mini · Micro</span>
              <small>no broker connected yet</small>
            </button>
          ))}
        </div>
        {specs?.length === 0 && <p className={styles.muted}>No futures contract specs are available.</p>}
        {pair && <div className={styles.contractToggle} aria-label="Contract size">
          {[pair.mini, pair.micro].map((contract) => (
            <button key={contract.root} type="button" aria-pressed={selectedContract === contract.root} onClick={() => chooseContract(contract)}>{contract.root}</button>
          ))}
          <span>{activeSpec ? `$${activeSpec.multiplier.toLocaleString("en-US")}/point · tick ${activeSpec.tick_size}` : "Spec unavailable"}</span>
        </div>}
      </section>

      <section className={styles.marketSection} aria-label="Futures chart and bias">
        <div className={styles.marketHeader}>
          <div><h2>{symbol} · daily chart</h2><p>{marketLoading ? "Loading market data…" : bars ? (bars.as_of ? `${qualityPhrase(bars.quality)} · as of ${formatAsOfText(bars.as_of)}` : "Not available until a broker is connected") : "Market data unavailable"}</p></div>
          <span className={styles.connectionBadge}>no broker connected yet</span>
        </div>
        {marketError && <p className={styles.error} role="status">{marketError}</p>}
        <MarketChart
          symbol={symbol}
          interval="1d"
          bars={bars?.bars ?? []}
          quality={bars?.quality ?? "unavailable"}
          asOf={bars?.as_of ?? null}
          height={370}
          levels={classicLevels(daily)}
        />
        <p className={styles.muted}>
          {!daily || daily.quality === "unavailable" || daily.as_of === null
            ? "Weekly levels and overnight range unavailable."
            : "Classic weekly pivots come from the Desk's daily bars; prior-week high/low/close and overnight range are unavailable."}
        </p>
        <div className={styles.biasGrid}>
          {([ ["1D", daily], ["4h", fourHour] ] as const).map(([label, value]) => (
            value
              ? <BiasGauge key={label} title={`${label} Desk Technical Bias`} gauge={value.gauges.summary} quality={value.quality} asOf={value.as_of} unavailable={value.quality === "unavailable" || value.as_of === null} />
              : <section className={styles.unavailableCard} key={label}><h3>{label} Desk Technical Bias</h3><p>Unavailable until a future data source returns closed bars.</p></section>
          ))}
        </div>
      </section>

      <section className={styles.sizerSection} aria-labelledby="futures-sizer-title">
        <header className={styles.blockHeading}><div><p className={styles.eyebrow}>REFERENCE ONLY · NO ORDERS</p><h2 id="futures-sizer-title">Micro-first risk sizing</h2></div><span>Margin · unavailable</span></header>
        <p className={styles.muted}>Uses the selected contract&apos;s dollars per point. This does not submit an order or estimate margin.</p>
        <div className={styles.sizerInputs}>
          <label>Risk budget ($)<input inputMode="decimal" type="number" min="0" step="any" value={risk} onChange={(event) => setRisk(event.currentTarget.value)} /></label>
          <label>Entry<input inputMode="decimal" type="number" step="any" value={entry} onChange={(event) => setEntry(event.currentTarget.value)} /></label>
          <label>Stop<input inputMode="decimal" type="number" step="any" value={stop} onChange={(event) => setStop(event.currentTarget.value)} /></label>
        </div>
        <div className={styles.sizingResult} aria-live="polite">
          {!sizing && <span>Enter positive risk, entry and stop to calculate a reference size.</span>}
          {sizing && sizing.contracts === null && <span>{sizing.reason}</span>}
          {sizing && sizing.contracts !== null && <>
            <strong>{sizing.contracts} {microSpec?.root ?? "micro"} contracts</strong>
            <span>{dollars(sizing.riskPerContract)} risk per micro · {dollars(sizing.riskPerContract === null ? null : sizing.riskPerContract * sizing.contracts)} total risk</span>
            <span>One {pair?.mini.root ?? "mini"} would risk {dollars(sizing.miniRisk)}.</span>
            {sizing.reason && <span>{sizing.reason}</span>}
          </>}
        </div>
      </section>

      <section className={styles.eventCard} aria-label="Week ahead events">
        <h2>Week ahead</h2>
        <p>Macro calendar unavailable · no event feed configured. No events are inferred.</p>
      </section>

      <section className={styles.phaseSix} aria-labelledby="phase-six-title">
        <p className={styles.phaseBadge}>EXAMPLE · NOT ACCOUNT DATA</p>
        <h2 id="phase-six-title">Positions, roll warnings &amp; weekend controls</h2>
        <p>Illustrative Paper examples only. They are not imported account positions, fills, or live P/L.</p>
        <div className={styles.fixturePositionGrid}>
          <article className={styles.fixturePosition}>
            <span className={styles.fixtureLabel}>EXAMPLE POSITION</span>
            <strong>MNQ Dec &apos;26 ×3 long</strong>
            <span>Entry 25,040.00 · stop 24,880.00 · target 25,440.00</span>
            <span>Sample last 25,118.50 · sample P/L +78.5 pts / +$471</span>
          </article>
          <article className={styles.fixturePosition}>
            <span className={styles.fixtureLabel}>ROLL WARNING EXAMPLE</span>
            <strong>MCL Nov &apos;26 ×2 short</strong>
            <span>Review contract before its roll date. No live position or roll trigger is connected.</span>
          </article>
        </div>
        <div className={styles.weekendFixture}>
          <strong>Weekend risk example</strong>
          <span>{activeSpec ? `CME session · ${activeSpec.session.close_time} ET close / ${activeSpec.session.open_time} ET reopen. A gap can skip a stop.` : "CME session hours unavailable."}</span>
        </div>
        <div className={styles.disabledControls}>
          <button type="button" disabled>Hold (keep stops) · needs broker setup</button>
          <button type="button" disabled>Flatten before 16:55 · needs broker setup</button>
        </div>
      </section>

      <p className={styles.disclaimer}>CME session references are not broker availability. No order actions are available.</p>
    </div>
  );
}
