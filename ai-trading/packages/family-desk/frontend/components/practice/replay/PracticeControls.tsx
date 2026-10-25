"use client";

import { useState, type FormEvent } from "react";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { changeTone, formatEtClock, formatPrice } from "@/lib/desk/format";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { OpenSide } from "@/lib/replay/keys";
import { formatR, formatUsd } from "@/lib/replay/journalView";
import type { MarkDraft } from "@/lib/replay/markInput";
import type { OpenTrade } from "@/lib/replay/schemas";
import styles from "./replay.module.css";

export type Composer = "stop" | "note" | null;

export type PracticeControlsProps = {
  side: OpenSide;
  openTrade: OpenTrade | null;
  lastPrice: number | null;
  draft: MarkDraft;
  onDraft: (draft: MarkDraft) => void;
  /** The plan asks for a stop on every entry and the stop field is empty. */
  stopHint: boolean;
  /** The open trade has no stop note although the plan asks for one: offer the one-click fix, never block (D-022). */
  stopMissing: boolean;
  /** When the open trade was entered (its entry mark); null when unknown. */
  since: string | null;
  /** Closed trades only: what is already banked. The header's Practice P/L adds the open trade to it. */
  realized: number;
  /** Closed trades plus the open trade at the last price. */
  pnl: number;
  composer: Composer;
  onComposer: (composer: Composer) => void;
  onLong: () => void;
  onShort: () => void;
  onExit: () => void;
  onStop: (price: string) => void;
  onNote: (text: string) => void;
  /** No session to mark: loading, or the session already ended. */
  disabled: boolean;
};

function OpenTradeCard({ trade, since, realized, pnl }: { trade: OpenTrade | null; since: string | null; realized: number; pnl: number }) {
  if (!trade) return <p className={styles.muted}>No open practice trade</p>;
  return (
    <div className={styles.openTrade}>
      <div className={styles.tradeHead}>
        <h3 className={styles.tradeTitle}>Open practice trade</h3>
        <SimulatedBadge />
      </div>
      <p className={styles.tradeLine}>
        {`${trade.side === "long" ? "Practice long" : "Practice short"} · ${trade.shares} shares`}
        {since && <span className={styles.muted}>{` · since ${formatEtClock(since)}`}</span>}
      </p>
      <dl className={styles.tradeCard} aria-label="Open practice trade">
        <div><dt>Entry</dt><dd>{formatPrice(trade.entry_price)}</dd></div>
        <div><dt>Stop note</dt><dd>{trade.stop_price == null ? "none" : formatPrice(trade.stop_price)}</dd></div>
        <div><dt>Last</dt><dd>{formatPrice(trade.last_price)}</dd></div>
        <div>
          <dt>Unrealized</dt>
          <dd data-tone={changeTone(trade.unrealized_usd)}>{formatUsd(trade.unrealized_usd)}{trade.r != null && ` · ${formatR(trade.r)}`}</dd>
        </div>
      </dl>
      <p className={styles.muted}>{`Realized so far ${formatUsd(realized)} · practice P/L ${formatUsd(pnl)}`}</p>
    </div>
  );
}

/** The stop or note form. It mounts when opened (key = which one), so its fields start from the last price or empty. */
function ComposerForm({ composer, lastPrice, onStop, onNote, onClose }: { composer: Exclude<Composer, null>; lastPrice: number | null; onStop: (price: string) => void; onNote: (text: string) => void; onClose: () => void }) {
  const [stopText, setStopText] = useState(lastPrice == null ? "" : String(lastPrice));
  const [noteText, setNoteText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (composer === "stop") onStop(stopText);
    else onNote(noteText);
    onClose();
  };
  return (
    <form className={styles.composer} onSubmit={submit} aria-label={composer === "stop" ? "Stop note" : "Practice note"}>
      {composer === "stop" ? (
        <label className={styles.field}>
          Stop price
          <input autoFocus className={styles.control} inputMode="decimal" value={stopText} onChange={(event) => setStopText(event.target.value)} />
        </label>
      ) : (
        <label className={styles.field}>
          Note
          <textarea autoFocus className={styles.control} rows={3} maxLength={280} value={noteText} onChange={(event) => setNoteText(event.target.value)} />
        </label>
      )}
      <div className={styles.buttonRow}>
        <button type="submit" className={`${styles.button} ${styles.primary}`}>Save</button>
        <button type="button" className={styles.button} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

/** Open-trade card, shares and stop fields, and the practice buttons (02o §a3). Marks are priced by the server at the playhead. */
export function PracticeControls(props: PracticeControlsProps) {
  const { side, openTrade, lastPrice, draft, onDraft, composer, onComposer, disabled } = props;
  const entering = side === "flat";
  return (
    <div className={styles.controls}>
      <OpenTradeCard trade={openTrade} since={props.since} realized={props.realized} pnl={props.pnl} />
      {props.stopMissing && (
        <p className={styles.nudgeLine} role="status">
          {"This entry has no stop note, and your plan asks for one. "}
          <button type="button" className={styles.linkButton} onClick={() => onComposer("stop")}>Add a stop note for this entry</button>
        </p>
      )}
      <div className={styles.fields}>
        <label className={styles.field}>
          Shares
          <input className={styles.control} inputMode="numeric" value={draft.shares ?? ""} onChange={(event) => onDraft({ ...draft, shares: event.target.value })} />
        </label>
        <label className={styles.field}>
          Stop price (optional)
          <input className={styles.control} inputMode="decimal" value={draft.stopPrice ?? ""} onChange={(event) => onDraft({ ...draft, stopPrice: event.target.value })} />
        </label>
      </div>
      {props.stopHint && entering && <p className={styles.hint}>Your plan asks for a stop on every entry. Type a stop price first, or add a stop note right after.</p>}
      <div className={styles.buttonRow}>
        <button type="button" className={`${styles.button} ${styles.long}`} disabled={disabled} title="Practice long (B)" onClick={props.onLong}>Long (B)</button>
        <button type="button" className={`${styles.button} ${styles.short}`} disabled={disabled} title="Practice short (S)" onClick={props.onShort}>Short (S)</button>
        <button type="button" className={styles.button} disabled={disabled || entering} title="Exit the open practice trade (X)" onClick={props.onExit}>Exit (X)</button>
      </div>
      <div className={styles.buttonRow}>
        <button type="button" className={styles.button} disabled={disabled || entering} title="Stop note (T)" onClick={() => onComposer("stop")}>Stop (T)</button>
        <button type="button" className={styles.button} disabled={disabled} title="Note (N)" onClick={() => onComposer("note")}>Note (N)</button>
      </div>
      {composer && <ComposerForm key={composer} composer={composer} lastPrice={lastPrice} onStop={props.onStop} onNote={props.onNote} onClose={() => onComposer(null)} />}
      <p className={styles.footnote}>{PRACTICE_COPY.priceFootnote}</p>
    </div>
  );
}
