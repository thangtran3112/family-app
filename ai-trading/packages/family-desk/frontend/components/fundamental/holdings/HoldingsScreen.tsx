"use client";

import { useEffect, useRef, useState } from "react";
import { useDeskUi, useHoldings } from "@/components/shell/desktop/DeskContext";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { AsOfLine } from "@/components/ui/AsOfLine";
import type { ImportState } from "@/lib/api/fundamentalSchemas";
import { COPY } from "@/lib/desk/freshness";
import { loadHoldings } from "@/lib/desk/holdings";
import { runHoldingsImport } from "@/lib/desk/holdingsImport";
import { accountOptions, holdingsEmptyText, totalsTiles } from "@/lib/desk/holdingsView";
import { loadSettings, saveSettings } from "@/lib/desk/settings";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { DEFAULT_COLUMNS, readFundamentalColumns, withFundamentalColumns, type MetricKey } from "@/lib/settings/fundamental";
import type { SettingsRecord } from "@/lib/settings/schema";
import { FundamentalRightRail } from "../rail/FundamentalRightRail";
import { ImportLine } from "../shared/ImportLine";
import { ImportText } from "../shared/ImportText";
import { ColumnsMenu, type ColumnsSaveStatus } from "./ColumnsMenu";
import { FundamentalsTable, PositionsTable } from "./HoldingsTables";
import { LotsPane } from "./LotsPane";
import fund from "../fundamental.module.css";
import styles from "./holdings.module.css";

// After "Import now" starts, the holdings are read again a few times while the statement is fetched.
const REFRESH_AFTER_MS = [2000, 6000, 12000];

/** FD3 Holdings (02n §b3): import line, account filter, totals, positions, chosen metric columns, and the tax lots of the selected symbol. */
export function HoldingsScreen() {
  const { maskValues, setMaskValues, selectedSymbol, setSelectedSymbol } = useDeskUi();
  const all = useHoldings();
  const [accountId, setAccountId] = useState<number | null>(null);
  // "All accounts" shares the shell's read; one account asks for its own totals (the API scopes them, the browser never re-adds).
  const filtered = useDeskQuery(`holdings:${accountId}`, (signal) => loadHoldings(accountId ?? undefined, { signal }), { enabled: accountId !== null, intervalMs: 60_000 });
  const data = accountId === null ? all.holdings : filtered.data;
  const refresh = accountId === null ? all.refresh : filtered.refresh;
  const failed = accountId === null ? all.failed : filtered.error !== null && filtered.data === null;
  const accounts = all.holdings?.accounts ?? data?.accounts ?? [];

  const settingsQuery = useDeskQuery("holdings-settings", (signal) => loadSettings({ signal }));
  const [savedSettings, setSavedSettings] = useState<SettingsRecord | null>(null);
  const record = savedSettings ?? settingsQuery.data?.settings ?? null;
  const [saveStatus, setSaveStatus] = useState<ColumnsSaveStatus>("idle");
  const [wanted, setWanted] = useState<MetricKey[] | null>(null);
  const saved = record ? readFundamentalColumns(record) : [...DEFAULT_COLUMNS];
  const chosen = saveStatus === "saving" || saveStatus === "error" ? (wanted ?? saved) : saved;

  async function saveColumns(next: MetricKey[]) {
    if (!record) return;
    setWanted(next);
    setSaveStatus("saving");
    try {
      const result = await saveSettings(withFundamentalColumns(record, next));
      setSavedSettings(result.settings);
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }

  const [importing, setImporting] = useState(false);
  const [importProblem, setImportProblem] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  async function importNow() {
    setImportProblem(null);
    setImporting(true);
    const result = await runHoldingsImport();
    if (!result.ok) {
      setImportProblem(result.text);
      setImporting(false);
      return;
    }
    refreshRef.current();
    REFRESH_AFTER_MS.forEach((wait, index) => {
      timers.current.push(window.setTimeout(() => {
        refreshRef.current();
        if (index === REFRESH_AFTER_MS.length - 1) setImporting(false);
      }, wait));
    });
  }

  // The first row is selected until she picks another (or the held symbol she picked is gone).
  const symbols = data?.rows.map((row) => row.symbol) ?? [];
  const firstSymbol = symbols[0] ?? null;
  const heldSelection = selectedSymbol !== null && symbols.includes(selectedSymbol);
  useEffect(() => {
    if (!heldSelection && firstSymbol !== null) setSelectedSymbol(firstSymbol);
  }, [heldSelection, firstSymbol, setSelectedSymbol]);

  const importState: ImportState | null = data ? (importing ? { ...data.import, state: "running" } : data.import) : null;
  const emptyText = data ? holdingsEmptyText(data.import, data.rows.length) : null;
  const selected = heldSelection ? selectedSymbol : firstSymbol;
  const stamp = data?.rows[0]?.stamp ?? null;
  const hiddenLead = COPY.valuesHidden.replace(/ · Show values$/, "");

  return (
    <div className={fund.screen} data-testid="fund-holdings">
      <header className={fund.head}>
        <h1 className={fund.pageTitle}>Holdings</h1>
        {stamp && !emptyText && <FreshnessBadge stamp={stamp} />}
        <select
          className={styles.select}
          aria-label="Account"
          value={accountId ?? ""}
          onChange={(event) => setAccountId(event.target.value === "" ? null : Number(event.target.value))}
        >
          {accountOptions(accounts).map((option) => (
            <option key={option.id ?? "all"} value={option.id ?? ""}>{option.label}</option>
          ))}
        </select>
        <button type="button" className={fund.button} onClick={() => void importNow()} disabled={importing} data-testid="fund-import">Import now</button>
      </header>
      <div className={styles.toolbar}>
        {importState && <ImportLine state={importState} />}
        {importProblem && <span className={styles.inlineProblem} role="status">{importProblem}</span>}
      </div>

      {failed ? (
        <ErrorBlock subject="holdings list" onRetry={refresh} />
      ) : data === null ? (
        <LoadingBlock label="Loading holdings…" height={240} />
      ) : emptyText ? (
        <EmptyBlock title={<ImportText text={emptyText} />} />
      ) : (
        <>
          {maskValues && (
            <p className={styles.hidden} data-testid="values-hidden">
              <span>{hiddenLead} ·</span>
              <button type="button" className={styles.textButton} onClick={() => setMaskValues(false)}>Show values</button>
            </p>
          )}
          <ul className={fund.tiles} aria-label="Portfolio totals">
            {totalsTiles(data.totals, maskValues).map((tile) => (
              <li key={tile.key} className={fund.tile}>
                <span className={fund.tileLabel}>{tile.label}</span>
                <span className={fund.tileValue} data-testid={tile.key === "value" ? "fund-holdings-value" : undefined}>{tile.value}</span>
                {tile.note && <span className={fund.tileNote} data-tone={tile.tone}>{tile.note}</span>}
              </li>
            ))}
          </ul>
          {stamp && <AsOfLine stamp={stamp} />}
          <section className={`${fund.panel} ${styles.tableCard}`} aria-label="Positions">
            <PositionsTable rows={data.rows} masked={maskValues} selected={selected} onSelect={setSelectedSymbol} />
          </section>
          <section className={`${fund.panel} ${styles.tableCard}`} aria-label="Fundamentals">
            <div className={styles.tableHead}>
              <h2 className={fund.panelTitle}>Fundamentals</h2>
              <ColumnsMenu chosen={chosen} disabled={!record || saveStatus === "saving"} status={saveStatus} onChange={(next) => void saveColumns(next)} onRetry={() => wanted && void saveColumns(wanted)} />
            </div>
            <FundamentalsTable rows={data.rows} chosen={chosen} masked={maskValues} selected={selected} onSelect={setSelectedSymbol} />
          </section>
          {selected && <LotsPane symbol={selected} masked={maskValues} accounts={accounts} />}
        </>
      )}
      <FundamentalRightRail symbol={selected} />
    </div>
  );
}
