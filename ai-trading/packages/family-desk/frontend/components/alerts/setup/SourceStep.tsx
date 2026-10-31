"use client";

import type { Problem } from "@/lib/api/schemas";
import { nameFor, type AlertForm, type SourceKind } from "@/lib/desk/alertForm";
import editorStyles from "@/components/screener/editor/editor.module.css";
import styles from "./setup.module.css";
import { problemLine } from "@/lib/desk/problemCopy";

const SOURCES: ReadonlyArray<readonly [SourceKind, string]> = [
  ["symbol", "Symbol"],
  ["watchlist", "Watchlist"],
  ["filter", "Screener filter"],
];

export function SourceStep({ form, onChange, problems, lists, filters }: {
  form: AlertForm;
  onChange: (next: AlertForm) => void;
  problems: readonly Problem[];
  lists: readonly { id: number; name: string }[];
  filters: readonly { id: number; name: string }[];
}) {
  return (
    <section className={styles.card} aria-labelledby="alert-step-source">
      <h2 id="alert-step-source" className={styles.stepTitle}>Source</h2>
      <label className={editorStyles.field}>
        <span>Name <span className={editorStyles.note}>(optional)</span></span>
        <input type="text" maxLength={80} placeholder={nameFor(form)} value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
      </label>
      <fieldset className={editorStyles.group}>
        <legend>Watch</legend>
        <div className={editorStyles.controls}>
          {SOURCES.map(([kind, label]) => (
            <label key={kind} className={editorStyles.option}>
              <input type="radio" name="alert-watch" checked={form.sourceKind === kind} onChange={() => onChange({ ...form, sourceKind: kind })} />
              {label}
            </label>
          ))}
        </div>
        {form.sourceKind === "symbol" && (
          <label className={editorStyles.field}>
            <span>Symbols (comma separated)</span>
            <input type="text" placeholder="NVDA, AMD" value={form.symbol} onChange={(event) => onChange({ ...form, symbol: event.target.value })} />
          </label>
        )}
        {form.sourceKind === "watchlist" &&
          (lists.length === 0 ? (
            <p className={editorStyles.note}>Create a watchlist first</p>
          ) : (
            <label className={editorStyles.field}>
              <span>Watchlist</span>
              <select value={form.watchlist} onChange={(event) => onChange({ ...form, watchlist: event.target.value })}>
                <option value="">Choose</option>
                {lists.map((list) => <option key={list.id} value={list.name}>{list.name}</option>)}
              </select>
            </label>
          ))}
        {form.sourceKind === "filter" &&
          (filters.length === 0 ? (
            <p className={editorStyles.note}>No screener filters yet</p>
          ) : (
            <label className={editorStyles.field}>
              <span>Screener filter</span>
              <select value={form.filter} onChange={(event) => onChange({ ...form, filter: event.target.value })}>
                <option value="">Choose</option>
                {filters.map((filter) => <option key={filter.id} value={filter.name}>{filter.name}</option>)}
              </select>
            </label>
          ))}
      </fieldset>
      {problems.map((problem, index) => (
        <span key={index} className={editorStyles.problem}>{problemLine(problem)}</span>
      ))}
    </section>
  );
}
