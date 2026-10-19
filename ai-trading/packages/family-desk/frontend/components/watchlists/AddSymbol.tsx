"use client";

import { useState, type FormEvent } from "react";
import { deskFetch } from "@/lib/api/client";
import { WatchlistItemOutSchema } from "@/lib/api/schemas";
import { canonicalWatchlistSymbol, type AssetType } from "@/lib/watchlists/symbols";
import styles from "./watchlists.module.css";

export function AddSymbol({ watchlistId, onAdded }: { watchlistId: number; onAdded: () => void }) {
  const [symbol, setSymbol] = useState("");
  const [assetType, setAssetType] = useState<AssetType>("stock");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = symbol.trim();
    if (!value) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const normalized = canonicalWatchlistSymbol(value, assetType);
      if (!normalized) throw new Error("Enter a symbol.");
      await deskFetch(`/api/desk/watchlists/${watchlistId}/items`, WatchlistItemOutSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: normalized, asset_type: assetType }),
      });
      setSymbol("");
      setMessage(`Added ${normalized}. Checking history…`);
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add symbol.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.addSymbol} onSubmit={submit}>
      <label className={styles.field}>
        <span>Add a symbol</span>
        <input
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={32}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setSymbol(next);
            if (next.trim().startsWith("/")) setAssetType("future");
          }}
          placeholder="AAPL or /ES"
          value={symbol}
        />
      </label>
      <label className={styles.field}>
        <span>Asset type</span>
        <select onChange={(event) => setAssetType(event.currentTarget.value as AssetType)} value={assetType}>
          <option value="stock">Stock</option>
          <option value="future">Future</option>
        </select>
      </label>
      <button className={styles.primaryButton} disabled={saving || !symbol.trim()} type="submit">
        {saving ? "Adding…" : "Add symbol"}
      </button>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.feedback} role="status">{message}</p>}
    </form>
  );
}
