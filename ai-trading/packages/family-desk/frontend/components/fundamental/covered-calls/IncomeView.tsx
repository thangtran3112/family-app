"use client";

import { useEffect, useState } from "react";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { AsOfLine } from "@/components/ui/AsOfLine";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { HoldingAccount, Income, ShortCall } from "@/lib/api/fundamentalSchemas";
import { withPriorities } from "@/lib/desk/columns";
import { accountLabel, formatDelta, incomeView, mostUrgentCall, NEEDS_TRADES_TEXT, NO_INCOME_TEXT, topRisk } from "@/lib/desk/coveredCallsView";
import { loadIncome, loadShortCalls } from "@/lib/desk/coveredCalls";
import { formatSignedPct } from "@/lib/desk/format";
import { formatUsdPrice, maskedQuantity, maskedUsd } from "@/lib/desk/mask";
import { useDeskQuery, type DeskQueryResult } from "@/lib/desk/useDeskQuery";
import styles from "../fundamental.module.css";
import local from "./coveredCalls.module.css";
import { IncomeChart } from "./IncomeChart";
import { RollPane } from "./RollPane";

/** FD5 Open calls & income: open short calls with their risks, the detail of the selected one, and premium by month. */
export function IncomeView({ accounts }: { accounts: readonly HoldingAccount[] }) {
  const { maskValues: masked, setSelectedSymbol } = useDeskUi();
  const calls = useDeskQuery("cc-short-calls", (signal) => loadShortCalls({ signal }), { intervalMs: 60_000 });
  const income = useDeskQuery("cc-income", (signal) => loadIncome(12, { signal }));
  const [chosenId, setChosenId] = useState<number | null>(null);
  const rows = calls.data ?? [];
  // The urgent call opens first (most risks, then nearest expiry); the table keeps the API order.
  const selected = rows.find((item) => item.id === chosenId) ?? mostUrgentCall(rows);
  const symbol = selected?.symbol ?? null;

  useEffect(() => {
    if (symbol) setSelectedSymbol(symbol);
  }, [symbol, setSelectedSymbol]);

  const columns = withPriorities<DenseColumn<ShortCall>>(
    [
      { key: "symbol", label: "Symbol", render: (c) => <strong className={local.strong}>{c.symbol}</strong> },
      { key: "account", label: "Account", render: (c) => accountLabel(accounts, c.account_id) },
      { key: "strike", label: "Strike", align: "right", render: (c) => formatUsdPrice(c.strike) },
      { key: "expiry", label: "Expiry", render: (c) => c.expiry },
      { key: "dte", label: "DTE", align: "right", render: (c) => c.dte },
      { key: "contracts", label: "Contracts", align: "right", render: (c) => maskedQuantity(masked, c.contracts) },
      { key: "spot", label: "Stock", align: "right", render: (c) => formatUsdPrice(c.spot) },
      { key: "moneyness_pct", label: "vs strike", align: "right", render: (c) => formatSignedPct(c.moneyness_pct, 1) },
      { key: "delta", label: "Δ", align: "right", render: (c) => formatDelta(c.delta) },
      {
        key: "risk",
        label: "Risk",
        render: (c) => (
          <span className={local.riskCell} title={c.risks.map((risk) => risk.text).join(" · ") || undefined}>
            {topRisk(c.risks)}
            {c.risks.length > 1 && <span className={local.riskMore}>+{c.risks.length - 1} more</span>}
          </span>
        ),
      },
    ],
    "fundShortCalls",
  );

  return (
    <>
      <section className={styles.panel} aria-label="Open short calls">
        <h2 className={styles.panelTitle}>Open short calls</h2>
        {!calls.data ? (
          calls.error !== null ? <ErrorBlock subject="open calls" onRetry={calls.refresh} /> : <LoadingBlock label="Loading open calls…" height={120} />
        ) : (
          <DenseTable
            caption="Open short calls"
            columns={columns}
            rows={rows}
            rowKey={(c) => String(c.id)}
            density="compact"
            selectedKey={selected ? String(selected.id) : null}
            onSelect={(c) => setChosenId(c.id)}
            empty={<EmptyBlock title="No open short calls" />}
          />
        )}
      </section>
      {selected && <RollPane key={selected.id} call={selected} accounts={accounts} masked={masked} />}
      <IncomePanel query={income} masked={masked} />
    </>
  );
}

function IncomePanel({ query, masked }: { query: DeskQueryResult<Income>; masked: boolean }) {
  const data = query.data;
  const view = data ? incomeView(data, masked) : null;
  return (
    <section className={styles.panel} aria-label="Premium by month" data-testid="fund-cc-income">
      <h2 className={styles.panelTitle}>Premium by month</h2>
      {!data || !view ? (
        query.error !== null ? <ErrorBlock subject="premium income" onRetry={query.refresh} /> : <LoadingBlock label="Loading premium income…" height={120} />
      ) : (
        <>
          {view.kind === "needs_trades" && <p className={styles.notice} role="status" data-testid="fund-cc-needs-trades">{NEEDS_TRADES_TEXT}</p>}
          {view.kind === "empty" && <p className={styles.notice} role="status">{NO_INCOME_TEXT}</p>}
          {view.kind === "ok" && (
            <>
              <IncomeChart chart={view.chart} masked={masked} />
              <p className={local.total}>Year to date {maskedUsd(masked, data.ytd_premium)}</p>
              {data.assignments.length > 0 && (
                <>
                  <h3 className={local.subTitle}>Assignments</h3>
                  <ul className={local.assignments}>
                    {data.assignments.map((assignment) => (
                      <li key={`${assignment.date}:${assignment.symbol}:${assignment.strike}`}>
                        <span>{assignment.date}</span>
                        <strong className={local.strong}>{assignment.symbol}</strong>
                        <span>{maskedQuantity(masked, assignment.contracts)} {assignment.contracts === 1 && !masked ? "contract" : "contracts"} at {formatUsdPrice(assignment.strike)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
          <AsOfLine stamp={data.source_stamp} />
        </>
      )}
    </section>
  );
}
