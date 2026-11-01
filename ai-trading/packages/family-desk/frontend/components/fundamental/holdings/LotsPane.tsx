"use client";

import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { Delta } from "@/components/ui/Delta";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { HoldingAccount } from "@/lib/api/fundamentalSchemas";
import { loadLots } from "@/lib/desk/holdings";
import { accountLabel, lotViews, shortCallViews, type LotView } from "@/lib/desk/holdingsView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import fund from "../fundamental.module.css";
import styles from "./holdings.module.css";

/** The selected symbol's tax lots and its short calls (02n §b3 FD3). Share and contract counts follow the mask. */
export function LotsPane({ symbol, masked, accounts }: { symbol: string; masked: boolean; accounts: readonly HoldingAccount[] }) {
  const query = useDeskQuery(`lots:${symbol}`, (signal) => loadLots(symbol, { signal }));
  const lots = query.data ? lotViews(query.data.lots, masked) : [];
  const calls = query.data ? shortCallViews(query.data.short_calls, masked) : [];

  const columns: DenseColumn<LotView>[] = [
    { key: "acquired", label: "Acquired", render: (lot) => lot.acquired },
    { key: "account", label: "Account", render: (lot) => accountLabel(accounts, lot.accountId) },
    { key: "shares", label: "Shares", align: "right", render: (lot) => lot.shares },
    { key: "cost", label: "Cost/share", align: "right", render: (lot) => lot.cost },
    { key: "term", label: "Term", render: (lot) => lot.term },
    { key: "gain", label: "Gain", align: "right", render: (lot) => <Delta tone={lot.gain.tone}>{lot.gain.text}</Delta> },
  ];

  return (
    <div className={styles.lotsGrid} data-testid="fund-lots">
      <Panel aria-label={`${symbol} tax lots`}>
        <PanelHeader title={`${symbol} · tax lots`} />
        {query.error !== null && query.data === null ? (
          <ErrorBlock subject="lot list" onRetry={query.refresh} />
        ) : query.data === null ? (
          <LoadingBlock label="Loading lots…" height={80} />
        ) : (
          <DenseTable caption={`${symbol} tax lots`} columns={columns} rows={lots} rowKey={(lot) => lot.key} density="compact" tight empty={<p className={fund.muted}>No tax lots for {symbol}</p>} />
        )}
      </Panel>
      <Panel aria-label={`${symbol} short calls`}>
        <PanelHeader title={`${symbol} · short calls`} />
        {query.data === null ? null : calls.length === 0 ? (
          <p className={fund.muted}>No open short calls on {symbol}</p>
        ) : (
          calls.map((call) => (
            <div key={call.key} className={styles.shortCall}>
              <strong>{call.title}</strong>
              <span className={fund.muted}>{accountLabel(accounts, call.accountId)} · {call.contracts} · {call.moneyness}</span>
              <ul className={styles.riskList}>
                {call.risks.map((risk, index) => (
                  <li key={index} data-quiet={call.risks.length === 1 && risk === "No risk flagged"}>{risk}</li>
                ))}
              </ul>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}
