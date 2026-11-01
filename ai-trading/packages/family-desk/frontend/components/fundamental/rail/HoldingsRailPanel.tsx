"use client";

import { useDeskUi, useHoldings } from "@/components/shell/desktop/DeskContext";
import { Delta } from "@/components/ui/Delta";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { holdingsEmptyText, railRows } from "@/lib/desk/holdingsView";
import type { ShellBand } from "@/lib/desk/viewport";
import { AiRatingChip } from "../shared/AiRatingChip";
import { ImportText } from "../shared/ImportText";
import styles from "./rail.module.css";

/** The Holdings tab of the Fundamental left rail (02n §b1): symbol, weight, change and the Desk AI dot; 1180 keeps symbol, weight and change. */
export function HoldingsRailPanel({ band }: { band: ShellBand }) {
  const { holdings, failed, refresh } = useHoldings();
  const { selectedSymbol, setSelectedSymbol } = useDeskUi();

  if (failed) return <ErrorBlock subject="holdings list" onRetry={refresh} />;
  if (holdings === null) return <LoadingBlock label="Loading holdings…" height={80} />;
  const emptyText = holdingsEmptyText(holdings.import, holdings.rows.length);
  if (emptyText) return <p className={styles.note} data-testid="fund-rail-holdings"><ImportText text={emptyText} /></p>;

  return (
    <ul className={styles.list} aria-label="Holdings" data-testid="fund-rail-holdings">
      {railRows(holdings.rows).map((row) => (
        <li key={row.symbol}>
          <button type="button" className={styles.row} data-band={band} aria-pressed={selectedSymbol === row.symbol} onClick={() => setSelectedSymbol(row.symbol)}>
            <span className={styles.symbol}>{row.symbol}</span>
            <span className={styles.weight}>{row.weight}</span>
            <Delta tone={row.change.tone} className={styles.change}>{row.change.text}</Delta>
            {band === "1440" && <span className={styles.dot}><AiRatingChip rating={row.rating} compact /></span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
