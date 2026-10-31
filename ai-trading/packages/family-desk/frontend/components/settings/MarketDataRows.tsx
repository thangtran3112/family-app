"use client";

import { useEffect, useState } from "react";
import type { MarketDataCard } from "@/lib/api/schemas";
import { classOf, COPY, ownerNote, rowNote, servingText } from "@/lib/desk/marketDataCopy";
import { loadMarketDataCard } from "@/lib/desk/marketData";
import styles from "./MarketDataRows.module.css";

// Mobile Settings · Market data (02t §6): "Mobile shows read-only status rows". The same three rows and the
// same words as the desktop card, with no controls -- the owner changes providers on the desktop.
export function MarketDataRows() {
  const [card, setCard] = useState<MarketDataCard | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    loadMarketDataCard()
      .then((value) => {
        if (active) setCard(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const quotes = card ? classOf(card, "equity_quotes") : null;
  const chains = card ? classOf(card, "option_chain") : null;
  const bars = card ? classOf(card, "equity_bars") : null;
  const rows = [
    { key: "quotes", title: "Stock quotes", source: quotes, note: rowNote("quotes", quotes) },
    { key: "options", title: "Option chains", source: chains, note: rowNote("options", chains) },
    { key: "bars", title: "Bars", source: bars, note: rowNote("bars", bars) },
  ] as const;

  return (
    <section className={styles.card} aria-labelledby="settings-market-data">
      <h2 id="settings-market-data" className={styles.eyebrow}>
        {COPY.title}
      </h2>
      {card === null && <p className={styles.note}>{failed ? COPY.loadFailed : COPY.loading}</p>}
      {card && (
        <>
          <dl className={styles.rows}>
            {rows.map((row) => (
              <div key={row.key} className={styles.row}>
                <dt className={styles.rowTitle}>{row.title}</dt>
                <dd className={styles.rowText}>
                  {servingText(row.key, card, row.source)}
                  <span className={styles.rowNote}>{` · ${row.note}`}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className={styles.note}>{ownerNote(card.owner)}</p>
        </>
      )}
    </section>
  );
}