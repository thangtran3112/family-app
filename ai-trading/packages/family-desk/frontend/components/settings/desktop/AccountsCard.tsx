"use client";

import { useState } from "react";
import { useHoldings } from "@/components/shell/desktop/DeskContext";
import { ImportLine } from "@/components/fundamental/shared/ImportLine";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import type { AccountType, HoldingAccount } from "@/lib/api/fundamentalSchemas";
import { COPY } from "@/lib/desk/freshness";
import { patchAccount } from "@/lib/desk/holdings";
import { ACCOUNT_SAVE_ERROR, ACCOUNT_TYPE_OPTIONS, ACCOUNT_LABEL_MAX, accountProblemText, validateAccountLabel } from "@/lib/settings/fundamentalView";
import styles from "./settingsDesktop.module.css";

/** An owner-set name and type per account (02n §c3 #5, §g.5). The API never returns a broker account number, so none is shown. */
export function AccountsCard({ disabled }: Readonly<{ disabled: boolean }>) {
  const { holdings, failed, refresh } = useHoldings();
  return (
    <section className={styles.card} aria-labelledby="settings-accounts" data-testid="settings-accounts">
      <h2 id="settings-accounts" className={styles.eyebrow}>Accounts</h2>
      {holdings === null ? (
        failed ? <ErrorBlock subject="accounts" onRetry={refresh} /> : <LoadingBlock label="Loading accounts…" height={64} />
      ) : holdings.accounts.length === 0 ? (
        <ImportLine state={holdings.import} linkSetup={false} />
      ) : (
        <>
          {holdings.accounts.map((account) => (
            <AccountRow key={account.id} account={account} disabled={disabled} onSaved={refresh} />
          ))}
          <p className={styles.helper}>The type sets the assignment note and which account to cover first. {COPY.tax}.</p>
        </>
      )}
    </section>
  );
}

function AccountRow({ account, disabled, onSaved }: Readonly<{ account: HoldingAccount; disabled: boolean; onSaved: () => void }>) {
  // What the row last saved; the inputs show the draft. `onSaved` re-reads the holdings so the rails pick the change up too.
  const [savedLabel, setSavedLabel] = useState(account.label);
  const [type, setType] = useState(account.type);
  const [label, setLabel] = useState(account.label);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "saved" | "error" } | null>(null);

  async function save(body: { label?: string; type?: AccountType }) {
    setBusy(true);
    const before = type;
    setMessage(null);
    try {
      await patchAccount(account.id, body);
      if (body.label !== undefined) setSavedLabel(body.label);
      setMessage({ text: body.label === undefined ? "Type saved" : "Name saved", tone: "saved" });
      onSaved();
    } catch (error) {
      if (body.type !== undefined) setType(before);
      setMessage({ text: error instanceof DeskApiError ? accountProblemText(error.problems) : ACCOUNT_SAVE_ERROR, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  function commitLabel() {
    if (label === savedLabel) return;
    const checked = validateAccountLabel(label);
    if (!checked.ok) return setMessage({ text: checked.message, tone: "error" });
    setLabel(checked.label);
    if (checked.label !== savedLabel) void save({ label: checked.label });
  }

  const locked = disabled || busy;
  return (
    <div className={styles.block} data-testid={`account-${account.id}`}>
      <div className={styles.inline}>
        <label className={styles.fieldLabel} htmlFor={`account-label-${account.id}`}>Account name</label>
        <input
          id={`account-label-${account.id}`}
          data-testid={`account-label-${account.id}`}
          className={`${styles.input} ${styles.textInput}`}
          type="text"
          value={label}
          maxLength={ACCOUNT_LABEL_MAX + 10}
          disabled={locked}
          onChange={(event) => { setLabel(event.currentTarget.value); setMessage(null); }}
          onBlur={commitLabel}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        />
        <label className={styles.fieldLabel} htmlFor={`account-type-${account.id}`}>Account type</label>
        <select
          id={`account-type-${account.id}`}
          data-testid={`account-type-${account.id}`}
          className={styles.input}
          value={type}
          disabled={locked}
          onChange={(event) => {
            const next = event.currentTarget.value as AccountType;
            setType(next);
            void save({ type: next });
          }}
        >
          {ACCOUNT_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {message && <span className={message.tone === "error" ? styles.errorText : styles.saved} role="status">{message.text}</span>}
      </div>
    </div>
  );
}
