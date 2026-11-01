"use client";

import { Button } from "@/components/ui/Button";
import { Checkbox, ChoiceGroup, Field, FieldGroup, Input, Radio, Select } from "@/components/ui/Field";
import type { Problem } from "@/lib/api/schemas";
import { problemsFor, type FilterForm } from "@/lib/desk/filterForm";
import { fieldError } from "@/lib/desk/problems";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { loadWatchlists } from "@/lib/desk/watchlists";

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
    <FieldGroup legend="Universe" error={fieldError([...problemsFor(problems, "watch.universe"), ...problemsFor(problems, "assetTypes")])}>
      <Radio name="filter-universe" label="US stocks and ETFs" checked={form.universe === "market"} onChange={() => pick("market")} />
      <Radio name="filter-universe" label="A watchlist" checked={form.universe === "watchlist"} onChange={() => pick("watchlist")} />
      {form.universe === "watchlist" && (
        <>
          <Field id="filter-watchlist" label="Watchlist">
            <Select value={form.watchlist} onChange={(event) => onChange({ ...form, watchlist: event.target.value })}>
              <option value="">
                {watchlists.loading ? "Loading watchlists…" : watchlists.error !== null ? "Couldn't load watchlists" : "Choose a watchlist"}
              </option>
              {names.map((name) => <option key={name} value={name}>{name}</option>)}
              {form.watchlist !== "" && !names.includes(form.watchlist) && <option value={form.watchlist}>{form.watchlist}</option>}
            </Select>
          </Field>
          {watchlists.error !== null && <Button onClick={watchlists.refresh}>Try again</Button>}
        </>
      )}
      <Radio name="filter-universe" label="Specific symbols" checked={form.universe === "symbols"} onChange={() => pick("symbols")} />
      {form.universe === "symbols" && (
        <Field id="filter-symbols" label="Symbols (comma or space separated)">
          <Input autoCapitalize="characters" autoComplete="off" placeholder="NVDA, AMD, TSLA" value={form.symbols} onChange={(event) => onChange({ ...form, symbols: event.target.value })} />
        </Field>
      )}
      <ChoiceGroup label="Asset types">
        <Checkbox label="Stocks" checked={types.includes("stock")} disabled={onlyType === "stock"} onChange={() => toggle("stock")} />
        <Checkbox label="ETFs" checked={types.includes("etf")} disabled={onlyType === "etf"} onChange={() => toggle("etf")} />
      </ChoiceGroup>
    </FieldGroup>
  );
}
