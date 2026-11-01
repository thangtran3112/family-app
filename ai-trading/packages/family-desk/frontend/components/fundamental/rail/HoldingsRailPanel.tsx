"use client";

import { useDeskUi, useHoldings } from "@/components/shell/desktop/DeskContext";
import { Delta } from "@/components/ui/Delta";
import { RailList, RailValue } from "@/components/ui/RailList";
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

  const rows = railRows(holdings.rows).map((row) => ({
    id: row.symbol,
    label: <strong>{row.symbol}</strong>,
    title: row.symbol,
    selected: selectedSymbol === row.symbol,
    onSelect: () => setSelectedSymbol(row.symbol),
    value: (
      <>
        <RailValue>{row.weight}</RailValue>
        <Delta tone={row.change.tone}>{row.change.text}</Delta>
        {band === "1440" && <AiRatingChip rating={row.rating} compact />}
      </>
    ),
  }));
  return <RailList rows={rows} label="Holdings" testId="fund-rail-holdings" className={styles.holdings} />;
}
