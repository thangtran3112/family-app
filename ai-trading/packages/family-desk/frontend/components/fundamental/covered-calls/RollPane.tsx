"use client";

import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { HoldingAccount, Roll, ShortCall } from "@/lib/api/fundamentalSchemas";
import { accountLabel, assignmentNoteText, costToCloseText, flagsText, formatDelta, moneynessWords, NO_RISKS } from "@/lib/desk/coveredCallsView";
import { loadRoll } from "@/lib/desk/coveredCalls";
import { asOfLine, COPY } from "@/lib/desk/freshness";
import { maskedQuantity, formatUsdPrice } from "@/lib/desk/mask";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "../fundamental.module.css";
import local from "./coveredCalls.module.css";

type RollChoice = Roll["candidates"][number];

const columns: DenseColumn<RollChoice>[] = [
  { key: "expiry", label: "Expiry", render: (c) => c.expiry },
  { key: "strike", label: "Strike", align: "right", render: (c) => formatUsdPrice(c.strike) },
  { key: "dte", label: "DTE", align: "right", render: (c) => c.dte },
  { key: "delta", label: "Δ", align: "right", render: (c) => formatDelta(c.delta) },
  { key: "net_credit", label: "Net credit", align: "right", render: (c) => <strong className={local.strong}>{formatUsdPrice(c.net_credit)}</strong> },
  { key: "flags", label: "Flags", render: (c) => <span className={local.flagsCell} title={flagsText(c.flags)}>{flagsText(c.flags)}</span> },
];

/** F6 merged into FD5: one open short call with every risk in words, the cost to close, the roll choices and the assignment note. */
export function RollPane({ call, accounts, masked }: { call: ShortCall; accounts: readonly HoldingAccount[]; masked: boolean }) {
  const roll = useDeskQuery(`cc-roll:${call.id}`, (signal) => loadRoll(call.id, { signal }));
  const data = roll.data;
  const quotesReady = data !== null && data.cost_to_close !== null && data.chain_stamp.freshness !== "unavailable";

  return (
    <section className={`${styles.panel} ${local.detail}`} aria-label="Open call detail" data-testid="fund-cc-roll">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>{call.symbol} ${call.strike} call · {call.expiry}</h2>
        <span className={styles.caption}>{accountLabel(accounts, call.account_id)}</span>
      </div>
      <p className={styles.muted}>
        Short {maskedQuantity(masked, call.contracts)} {call.contracts === 1 && !masked ? "contract" : "contracts"} · {call.dte} days left · stock {formatUsdPrice(call.spot)}, {moneynessWords(call.moneyness_pct)}
      </p>
      <div className={local.detailGrid}>
        <div>
          <h3 className={local.subTitle}>Risks</h3>
          {call.risks.length === 0 ? (
            <p className={styles.muted}>{NO_RISKS}</p>
          ) : (
            <ul className={local.detailList} data-testid="fund-cc-risks">
              {call.risks.map((risk) => <li key={risk.kind}>{risk.text}</li>)}
            </ul>
          )}
        </div>
        <div>
          <h3 className={local.subTitle}>If assigned</h3>
          {data ? <p className={styles.muted}>{assignmentNoteText(data.assignment_note)}</p> : <p className={styles.muted}>{COPY.tax}</p>}
        </div>
      </div>
      {!data ? (
        roll.error !== null ? <ErrorBlock subject="roll choices" onRetry={roll.refresh} /> : <LoadingBlock label="Loading roll choices…" height={96} />
      ) : !quotesReady ? (
        <p className={styles.notice} role="status" data-testid="fund-cc-roll-notconnected">{COPY.optionQuotesNotConnected}</p>
      ) : (
        <>
          <p className={styles.muted}>Cost to close {costToCloseText(data.cost_to_close)} · {asOfLine(data.chain_stamp)}</p>
          {data.candidates.length === 0 ? (
            <p className={styles.notice}>No roll earns a credit right now</p>
          ) : (
            <DenseTable caption="Roll choices" columns={columns} rows={data.candidates} rowKey={(c) => `${c.expiry}:${c.strike}`} density="compact" />
          )}
        </>
      )}
    </section>
  );
}
