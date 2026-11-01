"use client";

import type { Problem } from "@/lib/api/schemas";
import { nameFor, type AlertForm, type SourceKind } from "@/lib/desk/alertForm";
import { ChoiceGroup, Field, FieldError, FieldGroup, Input, Radio, Select } from "@/components/ui/Field";
import editorStyles from "@/components/screener/editor/editor.module.css";
import styles from "./setup.module.css";
import { problemLine } from "@/lib/desk/problems";

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
      <Field id="alert-name" label="Name" optional>
        <Input maxLength={80} placeholder={nameFor(form)} value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
      </Field>
      <FieldGroup legend="Watch">
        <ChoiceGroup label="Watch source">
          {SOURCES.map(([kind, label]) => (
            <Radio key={kind} name="alert-watch" label={label} checked={form.sourceKind === kind} onChange={() => onChange({ ...form, sourceKind: kind })} />
          ))}
        </ChoiceGroup>
        {form.sourceKind === "symbol" && (
          <Field id="alert-symbols" label="Symbols (comma separated)">
            <Input placeholder="NVDA, AMD" value={form.symbol} onChange={(event) => onChange({ ...form, symbol: event.target.value })} />
          </Field>
        )}
        {form.sourceKind === "watchlist" &&
          (lists.length === 0 ? (
            <p className={editorStyles.note}>Create a watchlist first</p>
          ) : (
            <Field id="alert-watchlist" label="Watchlist">
              <Select value={form.watchlist} onChange={(event) => onChange({ ...form, watchlist: event.target.value })}>
                <option value="">Choose</option>
                {lists.map((list) => <option key={list.id} value={list.name}>{list.name}</option>)}
              </Select>
            </Field>
          ))}
        {form.sourceKind === "filter" &&
          (filters.length === 0 ? (
            <p className={editorStyles.note}>No screener filters yet</p>
          ) : (
            <Field id="alert-filter" label="Screener filter">
              <Select value={form.filter} onChange={(event) => onChange({ ...form, filter: event.target.value })}>
                <option value="">Choose</option>
                {filters.map((filter) => <option key={filter.id} value={filter.name}>{filter.name}</option>)}
              </Select>
            </Field>
          ))}
      </FieldGroup>
      {problems.map((problem, index) => <FieldError key={index}>{problemLine(problem)}</FieldError>)}
    </section>
  );
}
