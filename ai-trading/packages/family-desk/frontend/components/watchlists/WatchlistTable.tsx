"use client";

import { useEffect, useState } from "react";
import type { Quote } from "@/lib/stream.ts";
import { openQuoteStream } from "@/lib/stream.ts";
import { qualityLabel } from "@/lib/labels";
import { cardBackValue } from "@/lib/watchlists/cardBack";
import { marketSymbolForItem } from "@/lib/watchlists/symbols";
import type { WatchlistItemsSchema } from "@/lib/api/schemas";
import styles from "./watchlists.module.css";

type Item = ReturnType<typeof WatchlistItemsSchema.parse>[number];

function WatchlistRow({
  item,
  signalCount,
  signalsLoading,
  signalsError,
  listName,
  removing,
  onRemove,
}: {
  item: Item;
  signalCount: number | undefined;
  signalsLoading: boolean;
  signalsError: boolean;
  listName: string;
  removing: boolean;
  onRemove: (symbol: string) => void;
}) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const marketSymbol = marketSymbolForItem(item.symbol, item.asset_type);
  const signalIdentityKnown = marketSymbol !== null
    && !(item.asset_type === "future" && !item.symbol.trim().startsWith("/"));

  useEffect(() => {
    if (!marketSymbol) return;
    return openQuoteStream(marketSymbol, setQuote);
  }, [marketSymbol]);

  return (
    <tr>
      <th scope="row">
        <span className={styles.symbol}>{marketSymbol ?? item.symbol}</span>
        <span className={styles.assetType}>{marketSymbol ? (item.asset_type === "future" ? "Future" : "Stock") : "Unsupported asset"}</span>
        {item.backfill === "pending" && <span className={styles.pending}>Backfilling history</span>}
      </th>
      <td data-label="Latest price">
        <strong className={styles.price}>{cardBackValue(quote?.close)}</strong>
      </td>
      <td data-label="Source quality">
        <span>{qualityLabel(quote?.quality ?? "unavailable")}</span>
        <time className={styles.asOf} dateTime={quote?.as_of}>{quote ? `As of ${quote.as_of}` : "As of unavailable"}</time>
      </td>
      <td data-label="Signals today">
        <strong>{!signalIdentityKnown || signalsError ? "not available" : signalsLoading ? "Loading…" : signalCount ?? 0}</strong>
      </td>
      <td data-label="Actions">
        <button
          aria-label={`Remove ${marketSymbol ?? item.symbol} from ${listName}`}
          className={styles.removeButton}
          disabled={removing}
          onClick={() => onRemove(item.symbol)}
          type="button"
        >
          {removing ? "Removing…" : "Remove"}
        </button>
      </td>
    </tr>
  );
}

export function WatchlistTable({
  items,
  signalCounts,
  signalsLoading,
  signalsError,
  listName,
  removingSymbols,
  onRemove,
}: {
  items: Item[];
  signalCounts: Record<string, number>;
  signalsLoading: boolean;
  signalsError: boolean;
  listName: string;
  removingSymbols: ReadonlySet<string>;
  onRemove: (symbol: string) => void;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.watchlistTable}>
        <thead><tr><th scope="col">Symbol</th><th scope="col">Latest price</th><th scope="col">Source quality</th><th scope="col">Signals today</th><th scope="col"><span className={styles.visuallyHidden}>Actions</span></th></tr></thead>
        <tbody>
          {items.map((item) => {
            const marketSymbol = marketSymbolForItem(item.symbol, item.asset_type);
            const signalIdentityKnown = marketSymbol !== null
              && !(item.asset_type === "future" && !item.symbol.trim().startsWith("/"));
            return (
              <WatchlistRow
                item={item}
                key={`${item.asset_type}:${item.symbol}`}
                listName={listName}
                onRemove={onRemove}
                removing={removingSymbols.has(item.symbol)}
                signalCount={signalIdentityKnown && marketSymbol ? signalCounts[marketSymbol] : undefined}
                signalsError={signalsError}
                signalsLoading={signalsLoading}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
