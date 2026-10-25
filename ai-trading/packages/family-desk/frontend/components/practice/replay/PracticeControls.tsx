"use client";

import { useState, type FormEvent } from "react";
import { changeTone, formatPrice } from "@/lib/desk/format";
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

function OpenTradeCard({ trade }: { trade: OpenTrade | null }) {
  if (!trade) return <p className={styles.muted}>No open practice trade</p>;
  return (
    <dl className={styles.tradeCard} aria-label="Open practice trade">
      <div><dt>Side</dt><dd>{trade.side === "long" ? "Long" : "Short"} {trade.shares}</dd></div>
      <div><dt>Practice price</dt><dd>{formatPrice(trade.entry_price)}</dd></div>
      <div><dt>Unrealized</dt><dd data-tone={changeTone(trade.unrealized_usd)}>{formatUsd(trade.unrealized_usd)}</dd></div>
      <div><dt>Stop</dt><dd>{trade.stop_price == null ? "none" : formatPrice(trade.stop_price)}</dd></div>
      {trade.r != null && <div><dt>R</dt><dd data-tone={changeTone(trade.r)}>{formatR(trade.r)}</dd></div>}
    </dl>
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
      <OpenTradeCard trade={openTrade} />
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
      {props.stopHint && entering && <p className={styles.hint}>Your plan asks for a stop on every entry.</p>}
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
