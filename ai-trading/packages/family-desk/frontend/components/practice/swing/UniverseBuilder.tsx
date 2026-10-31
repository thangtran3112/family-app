"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SymbolField } from "@/components/practice/hub/SymbolField";
import hub from "@/components/practice/hub/hub.module.css";
import modal from "@/components/practice/hub/newplan.module.css";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadFilters } from "@/lib/desk/screener";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { loadWatchlistItems, loadWatchlists } from "@/lib/desk/watchlists";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { HUB_SWING_COPY, hubSwingText } from "@/lib/replay/hubSwing";
import { isDailyRunOn, toggleFillFilter, toggleWatchlist, targetProblem, type SwingDraft, type SwingProblems } from "@/lib/replay/swingSetup";
import {
  addSymbol,
  excludedRows,
  prepProgressText,
  previewSummary,
  removeSymbol,
  universeNeedLine,
  universeRowView,
  type UniverseRowView,
} from "@/lib/replay/universeView";
import type { UniversePreviewState } from "./useUniversePreview";
import styles from "./swing.module.css";

type ListChoice = { id: number; name: string; count: number | null };

/** Her watchlists with their stock counts ("Swing seed · 6"). A list whose items fail to load still shows, without a count. */
function useWatchlistChoices() {
  return useDeskQuery<ListChoice[]>("swing:watchlists", async (signal) => {
    const lists = await loadWatchlists({ signal });
    return Promise.all(
      lists.map(async (list) => {
        const items = await loadWatchlistItems(list.id, { signal }).catch(() => null);
        return { id: list.id, name: list.name, count: items === null ? null : items.filter((item) => item.asset_type === "stock").length };
      }),
    );
  });
}

const COLUMNS: DenseColumn<UniverseRowView>[] = [
  { key: "symbol", label: "Symbol", render: (row) => <span className={styles.symbol}>{row.symbol}</span> },
  { key: "source", label: "Source", render: (row) => <span className={hub.chip}>{row.chip}</span> },
  { key: "prior_close", label: "Prior close", align: "right", render: (row) => row.priorClose },
  { key: "chg_20d", label: "20-day change", align: "right", render: (row) => <span className={styles[row.chg20dTone]}>{row.chg20d}</span> },
  { key: "dollar_volume", label: "Avg dollar volume", align: "right", render: (row) => row.dollarVolume },
  { key: "atr", label: "ATR %", align: "right", render: (row) => row.atr },
  { key: "warnings", label: "Warnings", render: (row) => <span className={styles.warning}>{row.warnings.join(" · ")}</span> },
];

/**
 * The universe of a swing thread (02p c1): her watchlists, symbols she adds by hand, up to three daily filters and the
 * liquidity fill, with the live table under them. Every figure on a row is as of the close before Day 1. The table
 * follows the inputs (the parent's `useUniversePreview`) and says when the pool data is still being prepared.
 */
export function UniverseBuilder({
  draft,
  onDraft,
  state,
  problems,
}: {
  draft: SwingDraft;
  onDraft: (draft: SwingDraft) => void;
  state: UniversePreviewState;
  problems: SwingProblems;
}) {
  const lists = useWatchlistChoices();
  const filters = useDeskQuery("swing:filters", (signal) => loadFilters({ signal }));
  const [typed, setTyped] = useState("");
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const daily = useMemo(() => (filters.data ?? []).filter((filter) => isDailyRunOn(filter.run_on)), [filters.data]);
  const pickedNames = daily.filter((filter) => draft.filterIds.includes(filter.id)).map((filter) => filter.name);
  const { preview } = state;
  // A removed name leaves the table at once; the new answer then fills the gap.
  const shown = useMemo(() => (preview?.rows ?? []).filter((row) => !draft.edits.remove.includes(row.symbol)).map(universeRowView), [preview, draft.edits.remove]);
  // A name left out for missing history stays on the list she sends until she removes it (M-04).
  const leftOut = useMemo(() => excludedRows(preview?.excluded ?? [], draft.edits), [preview, draft.edits]);

  function add() {
    const result = addSymbol(draft.edits, typed, shown.map((row) => row.symbol));
    setAddProblem(result.problem);
    if (result.problem) return;
    setTyped("");
    onDraft({ ...draft, edits: result.edits });
  }

  // Enter in the symbol box adds the name; it never submits the whole form. A suggestion picked with Enter was already handled.
  function onAddKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" || event.defaultPrevented) return;
    event.preventDefault();
    add();
  }

  function remove(symbol: string) {
    tableRef.current?.focus(); // the row goes away: keep the focus on the table
    onDraft({ ...draft, edits: removeSymbol(draft.edits, symbol) });
  }

  const targetError = problems.target ?? targetProblem(draft.target);

  return (
    <fieldset className={modal.section}>
      <legend className={modal.legend}>{PRACTICE_COPY.swingUniverseSection}</legend>
      <p className={modal.help}>{universeNeedLine(shown.length)}</p>
      <p className={modal.help}>{PRACTICE_COPY.swingListOrder}</p>
      <div className={styles.sources}>
        <fieldset className={styles.source}>
          <legend className={modal.legend}>{PRACTICE_COPY.swingWatchlists}</legend>
          {lists.loading ? (
            <LoadingBlock label="Loading your watchlists…" height={48} />
          ) : lists.data === null ? (
            <ErrorBlock subject="watchlists" onRetry={lists.refresh} />
          ) : lists.data.length === 0 ? (
            <p className={modal.help}>{HUB_SWING_COPY.noWatchlists}</p>
          ) : (
            <ul className={styles.checkList}>
              {lists.data.map((list) => (
                <li key={list.id}>
                  <label className={hub.armRow}>
                    <input
                      type="checkbox"
                      className={hub.check}
                      checked={draft.watchlistIds.includes(list.id)}
                      onChange={() => onDraft({ ...draft, watchlistIds: toggleWatchlist(draft.watchlistIds, list.id) })}
                    />
                    <span className={hub.armText}>
                      <span className={hub.armName}>{list.count === null ? list.name : `${list.name} · ${list.count}`}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <fieldset className={styles.source}>
          <legend className={modal.legend}>{PRACTICE_COPY.swingAddSymbols}</legend>
          <div className={styles.addRow}>
            <div onKeyDown={onAddKey}>
              <SymbolField value={typed} onChange={(symbol) => { setTyped(symbol); setAddProblem(null); }} error={addProblem ?? undefined} />
            </div>
            <button type="button" className={hub.button} onClick={add}>{HUB_SWING_COPY.addSymbol}</button>
          </div>
          <p className={modal.help}>{PRACTICE_COPY.swingTypeSymbol}</p>
        </fieldset>

        <fieldset className={styles.source} aria-describedby="swing-filter-hint">
          <legend className={modal.legend}>{PRACTICE_COPY.swingAddFromFilter}</legend>
          <p id="swing-filter-hint" className={modal.help}>{PRACTICE_COPY.swingAddFromFilterHint}</p>
          {filters.loading ? (
            <LoadingBlock label="Loading your filters…" height={48} />
          ) : filters.data === null ? (
            <ErrorBlock subject="filter list" onRetry={filters.refresh} />
          ) : daily.length === 0 ? (
            <p className={modal.help}>{HUB_SWING_COPY.noDailyFilters}</p>
          ) : (
            <ul className={styles.checkList}>
              {daily.map((filter) => {
                const checked = draft.filterIds.includes(filter.id);
                const disabled = !checked && draft.filterIds.length >= 3;
                return (
                  <li key={filter.id}>
                    <label className={hub.armRow} data-disabled={disabled ? "true" : undefined}>
                      <input
                        type="checkbox"
                        className={hub.check}
                        checked={checked}
                        disabled={disabled}
                        onChange={() => onDraft({ ...draft, filterIds: toggleFillFilter(draft.filterIds, filter.id) })}
                      />
                      <span className={hub.armText}>
                        <span className={hub.armName}>{filter.name}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <fieldset className={styles.source}>
          <legend className={modal.legend}>{PRACTICE_COPY.swingAddByLiquidity}</legend>
          <label className={hub.switch}>
            <input
              type="checkbox"
              className={hub.check}
              checked={draft.fill === "liquidity"}
              onChange={(event) => onDraft({ ...draft, fill: event.target.checked ? "liquidity" : "none" })}
            />
            {PRACTICE_COPY.swingAddByLiquidity}
          </label>
          <p className={modal.help}>{PRACTICE_COPY.swingAddByLiquidityHint}</p>
          <div className={hub.field}>
            <label htmlFor="swing-target" className={hub.label}>{PRACTICE_COPY.swingTarget}</label>
            <input
              id="swing-target"
              type="number"
              inputMode="numeric"
              min={10}
              max={50}
              step={1}
              className={`${hub.control} ${styles.targetBox}`}
              value={draft.target}
              aria-invalid={targetError ? true : undefined}
              aria-describedby={targetError ? "swing-target-error" : undefined}
              onChange={(event) => onDraft({ ...draft, target: event.target.value })}
            />
            {targetError && <p id="swing-target-error" role="alert" className={modal.fieldError}>{targetError}</p>}
          </div>
        </fieldset>
      </div>

      <div className={styles.tableBlock}>
        <div className={styles.tableHead}>
          <p className={modal.help} role="status">
            {preview ? prepProgressText(preview) : state.busy ? HUB_SWING_COPY.buildingList : PRACTICE_COPY.swingBuildFirst}
            {preview && state.busy && preview.state === "ready" && ` · ${HUB_SWING_COPY.updatingList}`}
          </p>
          {state.expired && <p className={modal.fieldError} role="alert">{HUB_SWING_COPY.tooLong}</p>}
        </div>
        {state.failure && (
          <div className={hub.inline}>
            <p role="alert" className={modal.fieldError}>{state.failure}</p>
            <button type="button" className={hub.button} onClick={state.retry}>Try again</button>
          </div>
        )}
        {problems.universe && <p role="alert" className={modal.fieldError}>{problems.universe}</p>}
        {preview === null ? null : (
          <>
            <p className={styles.summary}>{previewSummary(preview, pickedNames)}</p>
            <div className={styles.tableWrap} ref={tableRef} tabIndex={-1}>
              <DenseTable
                caption="Swing universe"
                columns={COLUMNS}
                rows={shown}
                rowKey={(row) => row.symbol}
                density="compact"
                dim={!state.fresh}
                empty={HUB_SWING_COPY.noRows}
                rowActions={(row) => (
                  <button type="button" className={hub.small} aria-label={hubSwingText("removeRow", { symbol: row.symbol })} onClick={() => remove(row.symbol)}>
                    Remove
                  </button>
                )}
              />
            </div>
            {leftOut.length > 0 && (
              <ul className={modal.leftOut} aria-label="Left out">
                {leftOut.map((item) => (
                  <li key={item.symbol} className={modal.leftOutRow}>
                    <span className={modal.help}>{practiceText("swingExcludedRow", { symbol: item.symbol, reason: item.reason })}</span>
                    <button type="button" className={hub.small} aria-label={hubSwingText("removeRow", { symbol: item.symbol })} onClick={() => remove(item.symbol)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className={styles.survivorship}>{preview.label}</p>
          </>
        )}
      </div>
    </fieldset>
  );
}
