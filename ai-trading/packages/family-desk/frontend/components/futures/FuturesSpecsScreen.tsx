"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FuturesSpecsSchema } from "@/lib/api/schemas";
import { deskFetch } from "@/lib/api/client";
import { marginText, rollEvents } from "@/lib/futures/specs";
import styles from "./futures.module.css";

type FuturesSpec = ReturnType<typeof FuturesSpecsSchema.parse>[number];
type FuturePair = { mini: FuturesSpec; micro: FuturesSpec };

const names: Record<string, string> = {
  ES: "E-mini S&P 500", MES: "Micro E-mini S&P 500",
  NQ: "E-mini Nasdaq-100", MNQ: "Micro E-mini Nasdaq-100",
  RTY: "E-mini Russell 2000", M2K: "Micro E-mini Russell 2000",
  YM: "E-mini Dow", MYM: "Micro E-mini Dow",
  CL: "Crude Oil (WTI)", MCL: "Micro WTI Crude Oil",
  GC: "Gold", MGC: "Micro Gold",
};

function pairsFromSpecs(specs: FuturesSpec[]): FuturePair[] {
  return specs.flatMap((mini) => {
    if (mini.root !== mini.mini || mini.mini === mini.micro) return [];
    const micro = specs.find((item) => item.root === mini.micro);
    return micro ? [{ mini, micro }] : [];
  });
}

function numeric(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function FuturesSpecsScreen() {
  const [specs, setSpecs] = useState<FuturesSpec[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void deskFetch("/api/desk/futures/specs", FuturesSpecsSchema).then((result) => {
      if (active) setSpecs(result);
    }).catch(() => {
      if (active) setError("Futures reference specs are unavailable.");
    });
    return () => { active = false; };
  }, [reload]);

  function retry() {
    setSpecs(null);
    setError("");
    setReload((value) => value + 1);
  }
  const pairs = useMemo(() => pairsFromSpecs(specs ?? []), [specs]);
  const nextRolls = useMemo(() => rollEvents(specs ?? []), [specs]);
  const sessions = useMemo(() => [...new Map((specs ?? []).map(({ session }) => [`${session.open_time}-${session.close_time}`, session])).values()], [specs]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div><p className={styles.eyebrow}>FUTURES · REFERENCE</p><h1>Futures specs &amp; roll calendar</h1><p className={styles.subtitle}>12 contracts · mini/micro pairs · roll dates included · margin is not available</p></div>
        <Link className={styles.secondaryLink} href="/futures">Back to futures swing</Link>
      </header>
      <p className={styles.sourceNote}>Contract multipliers, tick sizes, sessions, and roll dates are the Desk&apos;s own reference data. No broker is connected.</p>
      {!specs && !error && <p role="status" className={styles.muted}>Loading contract reference…</p>}
      {error && <div className={styles.error} role="alert">{error}<button type="button" onClick={retry}>Try again</button></div>}

      {specs?.length === 0 && <p className={styles.muted}>No futures contract specs are available.</p>}
      {specs && <>
        <section className={styles.specSection}>
          <h2>12 contracts · mini and micro</h2>
          <div className={styles.tableScroll}>
            <table className={styles.specTable}>
              <thead><tr>
                <th scope="col">Symbol</th><th scope="col">Contract</th><th scope="col">$ / point</th><th scope="col">Tick → $ / tick</th><th scope="col">Roll dates</th><th scope="col">Approx. margin</th>
              </tr></thead>
              <tbody>{specs.map((spec) => (
                <tr key={spec.root}>
                  <th scope="row">{spec.root}</th>
                  <td>{names[spec.root] ?? spec.root}</td>
                  <td>{numeric(spec.multiplier)}</td>
                  <td>{numeric(spec.tick_size)} → {numeric(spec.multiplier * spec.tick_size)}</td>
                  <td>{spec.roll_dates.length ? spec.roll_dates.join(" · ") : "unavailable"}</td>
                  <td><strong>{marginText(spec.approx_margin, spec.margin_as_of)}</strong></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>

        <section className={styles.specSection}>
          <h2>Mini ↔ micro equivalence · from contract multipliers</h2>
          <div className={styles.equivalenceGrid}>
            {pairs.map(({ mini, micro }) => {
              const ratio = mini.multiplier / micro.multiplier;
              return <div className={styles.equivalence} key={mini.root}><strong>{numeric(ratio)} {micro.root}</strong><span>=</span><strong>1 {mini.root}</strong></div>;
            })}
          </div>
        </section>

        <section className={styles.specSection}>
          <h2>Upcoming roll dates</h2>
          <ol className={styles.rollTimeline}>
            {nextRolls.map(({ roots, date }) => <li key={`${date}-${roots.join("-")}`}><time dateTime={date}>{date}</time><span>{roots.join(" / ")} roll</span></li>)}
            {nextRolls.length === 0 && <li><span>Roll dates unavailable.</span></li>}
          </ol>
        </section>

        <section className={styles.specSection}>
          <h2>Session hours · ET</h2>
          <div className={styles.sessionGrid}>
            {sessions.map((session) => <div className={styles.sessionCard} key={`${session.open_time}-${session.close_time}`}>
              <span>CME Globex</span>
              <strong>Sun {session.open_time} → Fri {session.close_time} ET</strong>
              <small>Daily maintenance break · {session.close_time}–{session.open_time} ET</small>
            </div>)}
          </div>
        </section>
      </>}
      <p className={styles.disclaimer}>Reference specifications only. Approximate broker margins remain unavailable; no margin or order value is inferred.</p>
    </div>
  );
}
