"use client";

import { useEffect, useState } from "react";
import type { Quote } from "@/lib/stream.ts";
import { openQuoteStream } from "@/lib/stream.ts";
import { qualityLabel } from "@/lib/labels";
import { cardBackValue } from "@/lib/watchlists/cardBack";
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

  useEffect(() => {
    return openQuoteStream(item.symbol, setQuote);
  }, [item.symbol]);

  return (
    <tr>
      <th scope="row">
        <span className={styles.symbol}>{item.symbol}</span>
        <span className={styles.assetType}>{item.asset_type === "future" ? "Future" : "Stock"}</span>
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
        <strong>{signalsLoading ? "Loading…" : signalsError ? "not available" : signalCount ?? 0}</strong>
      </td>
      <td data-label="Actions">
        <button
          aria-label={`Remove ${item.symbol} from ${listName}`}
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
          {items.map((item) => (
            <WatchlistRow
              item={item}
              key={item.symbol}
              listName={listName}
              onRemove={onRemove}
              removing={removingSymbols.has(item.symbol)}
              signalCount={signalCounts[item.symbol]}
              signalsError={signalsError}
              signalsLoading={signalsLoading}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
