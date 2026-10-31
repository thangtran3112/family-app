"use client";

import { useEffect, useState } from "react";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { CoverageRow, HoldingAccount, ImportState } from "@/lib/api/fundamentalSchemas";
import { accountLabel, capText, coverageReason, defaultCoverageRow } from "@/lib/desk/coveredCallsView";
import { loadCoverage } from "@/lib/desk/coveredCalls";
import { importLine } from "@/lib/desk/fundamentalView";
import { maskedQuantity } from "@/lib/desk/mask";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { ImportText } from "../shared/ImportText";
import styles from "../fundamental.module.css";
import local from "./coveredCalls.module.css";
import { CandidatesPanel } from "./CandidatesPanel";

const rowKey = (row: Pick<CoverageRow, "symbol" | "account_id">) => `${row.symbol}:${row.account_id}`;

/** FD4 Scan: coverage per holding and account with the reason in words; the top calls of the selected holding below. */
export function ScanView({ accounts, importState }: { accounts: readonly HoldingAccount[]; importState: ImportState | null }) {
  const { maskValues: masked, setSelectedSymbol } = useDeskUi();
  const coverage = useDeskQuery("cc-coverage", (signal) => loadCoverage({ signal }), { intervalMs: 60_000 });
  const [chosen, setChosen] = useState<string | null>(null);
  const rows = coverage.data?.rows ?? [];
  const row = rows.find((item) => rowKey(item) === chosen) ?? defaultCoverageRow(rows);
  const symbol = row?.symbol ?? null;

  // The rails describe the symbol the scan is showing.
  useEffect(() => {
    if (symbol) setSelectedSymbol(symbol);
  }, [symbol, setSelectedSymbol]);

  const columns: DenseColumn<CoverageRow>[] = [
    { key: "symbol", label: "Symbol", render: (item) => <strong className={local.strong}>{item.symbol}</strong> },
    { key: "account", label: "Account", render: (item) => accountLabel(accounts, item.account_id) },
    { key: "shares", label: "Shares", align: "right", render: (item) => maskedQuantity(masked, item.shares) },
    { key: "open_contracts", label: "Open", align: "right", render: (item) => maskedQuantity(masked, item.open_contracts) },
    { key: "coverable", label: "Coverable", align: "right", render: (item) => maskedQuantity(masked, item.coverable) },
    { key: "reason", label: "Why", render: (item) => coverageReason(item, masked) },
  ];

  if (!coverage.data) {
    return coverage.error !== null ? <ErrorBlock subject="coverage" onRetry={coverage.refresh} /> : <LoadingBlock label="Loading coverage…" height={160} />;
  }
  return (
    <>
      <section className={styles.panel} aria-label="Coverage">
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Coverage</h2>
          <p className={local.cap}>{capText(coverage.data.cap_pct)}</p>
        </div>
        <DenseTable
          caption="Coverage"
          columns={columns}
          rows={rows}
          rowKey={rowKey}
          density="compact"
          selectedKey={row ? rowKey(row) : null}
          onSelect={(item) => setChosen(rowKey(item))}
          empty={<EmptyBlock title={importState ? <ImportText text={importLine(importState).text} /> : "No holdings to cover yet"} />}
        />
      </section>
      {row && <CandidatesPanel key={rowKey(row)} row={row} accountName={accountLabel(accounts, row.account_id)} />}
    </>
  );
}
