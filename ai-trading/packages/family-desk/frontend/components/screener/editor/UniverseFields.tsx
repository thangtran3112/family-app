"use client";

import type { Problem } from "@/lib/api/schemas";
import { problemsFor, type FilterForm } from "@/lib/desk/filterForm";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { loadWatchlists } from "@/lib/desk/watchlists";
import styles from "./editor.module.css";
import { problemText } from "@/lib/desk/problems";

export function UniverseFields({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  const watchlists = useDeskQuery("watchlists", (signal) => loadWatchlists({ signal }), { enabled: form.universe === "watchlist" });
  const names = (watchlists.data ?? []).map((watchlist) => watchlist.name);
  const types = form.assetTypes ?? ["stock", "etf"];
  const onlyType = types.length === 1 ? types[0] : null;
  const pick = (universe: FilterForm["universe"]) => onChange({ ...form, universe });
  // Both boxes or neither means "not specified" (null). The only checked box is disabled, so unchecking it cannot leave an empty list.
  const toggle = (type: "stock" | "etf") => {
    const next = types.includes(type) ? types.filter((item) => item !== type) : [...types, type];
    onChange({ ...form, assetTypes: next.length === 1 ? next : null });
  };

  return (
    <fieldset className={styles.group}>
      <legend>Universe</legend>
      <label className={styles.option}>
        <input type="radio" name="filter-universe" checked={form.universe === "market"} onChange={() => pick("market")} />
        US stocks and ETFs
      </label>
      <label className={styles.option}>
        <input type="radio" name="filter-universe" checked={form.universe === "watchlist"} onChange={() => pick("watchlist")} />
        A watchlist
      </label>
      {form.universe === "watchlist" && (
        <>
          <label className={styles.field}>
            <span>Watchlist</span>
            <select value={form.watchlist} onChange={(event) => onChange({ ...form, watchlist: event.target.value })}>
              <option value="">
                {watchlists.loading ? "Loading watchlists…" : watchlists.error !== null ? "Couldn't load watchlists" : "Choose a watchlist"}
              </option>
              {names.map((name) => <option key={name} value={name}>{name}</option>)}
              {form.watchlist !== "" && !names.includes(form.watchlist) && <option value={form.watchlist}>{form.watchlist}</option>}
            </select>
          </label>
          {watchlists.error !== null && <button type="button" className={styles.button} onClick={watchlists.refresh}>Try again</button>}
        </>
      )}
      <label className={styles.option}>
        <input type="radio" name="filter-universe" checked={form.universe === "symbols"} onChange={() => pick("symbols")} />
        Specific symbols
      </label>
      {form.universe === "symbols" && (
        <label className={styles.field}>
          <span>Symbols (comma or space separated)</span>
          <input type="text" autoCapitalize="characters" autoComplete="off" placeholder="NVDA, AMD, TSLA" value={form.symbols} onChange={(event) => onChange({ ...form, symbols: event.target.value })} />
        </label>
      )}
      {problemsFor(problems, "watch.universe").map((problem, index) => (
        <span key={index} className={styles.problem}>{problemText(problem)}</span>
      ))}
      <div role="group" aria-label="Asset types" className={styles.controls}>
        <label className={styles.option}>
          <input type="checkbox" checked={types.includes("stock")} disabled={onlyType === "stock"} onChange={() => toggle("stock")} />
          Stocks
        </label>
        <label className={styles.option}>
          <input type="checkbox" checked={types.includes("etf")} disabled={onlyType === "etf"} onChange={() => toggle("etf")} />
          ETFs
        </label>
      </div>
      {problemsFor(problems, "assetTypes").map((problem, index) => (
        <span key={index} className={styles.problem}>{problemText(problem)}</span>
      ))}
    </fieldset>
  );
}
