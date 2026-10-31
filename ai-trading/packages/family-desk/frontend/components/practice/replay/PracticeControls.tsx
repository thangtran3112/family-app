"use client";

import { useId, useState, type FormEvent } from "react";
import play from "@/components/practice/swing/play.module.css";
import { SwingOpenTradeCard } from "@/components/practice/swing/SwingOpenTradeCard";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { changeTone, formatEtClock, formatPrice } from "@/lib/desk/format";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { OpenSide } from "@/lib/replay/keys";
import { formatR, formatUsd } from "@/lib/replay/journalView";
import type { MarkDraft } from "@/lib/replay/markInput";
import type { OpenTrade } from "@/lib/replay/schemas";
import type { SizingHint } from "@/lib/replay/swing";
import styles from "./replay.module.css";

export type Composer = "stop" | "note" | null;

/** Swing session only (02p b2): the practice-hold card, the cash line, the sizing hint and the shares default. */
export type SwingControls = {
  tape: "on" | "off";
  /** "Free cash $24,720" */
  cash: string;
  /** Risk ÷ |last − stop|, capped by free cash; a hint only, shown while she is flat. */
  hint: SizingHint | null;
  /** The shares field's value until she types in it: the hint's size, else 100. */
  defaultShares: string;
};

export type PracticeControlsProps = {
  side: OpenSide;
  openTrade: OpenTrade | null;
  lastPrice: number | null;
  draft: MarkDraft;
  onDraft: (draft: MarkDraft) => void;
  /** The plan asks for a stop on every entry and the stop field is empty. */
  stopHint: boolean;
  /** The plan asks for a stop on every entry (D-060): an entry is refused without one. */
  stopRequired: boolean;
  /** The open trade has no stop note although the plan asks for one (an entry from before the server refused it): offer the one-click fix (D-022). */
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
  swing?: SwingControls;
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
  const { side, openTrade, lastPrice, draft, onDraft, composer, onComposer, disabled, swing } = props;
  const entering = side === "flat";
  // D-060: with the plan asking for a stop on every entry, Long and Short wait until a stop price is typed.
  const waitsForStop = props.stopHint && entering;
  // The inputs are named by a real `for` link, and the reason Long and Short wait is the stop field's and the buttons' description (D-101).
  const sharesId = useId();
  const stopId = useId();
  const hintId = useId();
  const hintShown = props.stopHint && entering;
  return (
    <div className={styles.controls}>
      {swing ? <SwingOpenTradeCard trade={openTrade} tape={swing.tape} /> : <OpenTradeCard trade={openTrade} since={props.since} realized={props.realized} pnl={props.pnl} />}
      {swing && <dl className={play.card} aria-label="Free cash"><div><dt>Free cash</dt><dd>{swing.cash.replace(/^Free cash\s+/, "")}</dd></div></dl>}
      {swing?.hint && entering && <p className={play.hint}>{swing.hint.text}</p>}
      {props.stopMissing && (
        <p className={styles.nudgeLine} role="status">
          {"This entry has no stop note, and your plan asks for one. "}
          <button type="button" className={styles.linkButton} onClick={() => onComposer("stop")}>Add a stop note for this entry</button>
        </p>
      )}
      <div className={styles.fields}>
        <label className={styles.field} htmlFor={sharesId}>
          Shares
          <input id={sharesId} className={styles.control} inputMode="numeric" value={draft.shares ?? swing?.defaultShares ?? ""} onChange={(event) => onDraft({ ...draft, shares: event.target.value })} />
        </label>
        <label className={styles.field} htmlFor={stopId}>
          {entering ? (props.stopRequired ? "Stop price (required)" : "Stop price (optional)") : "Stop price"}
          <input id={stopId} className={styles.control} inputMode="decimal" aria-describedby={hintShown ? hintId : undefined} value={draft.stopPrice ?? ""} onChange={(event) => onDraft({ ...draft, stopPrice: event.target.value })} />
        </label>
      </div>
      {hintShown && <p id={hintId} className={styles.hint} role="status">{PRACTICE_COPY.stopFirst}</p>}
      <p className={styles.footnote}>{swing ? PRACTICE_COPY.entryResetsSwing : PRACTICE_COPY.entryResets}</p>
      <div className={styles.buttonRow}>
        <button type="button" className={`${styles.button} ${styles.long}`} disabled={disabled || waitsForStop} aria-describedby={waitsForStop ? hintId : undefined} title={waitsForStop ? PRACTICE_COPY.stopFirst : "Practice long (B)"} onClick={props.onLong}>Long (B)</button>
        <button type="button" className={`${styles.button} ${styles.short}`} disabled={disabled || waitsForStop} aria-describedby={waitsForStop ? hintId : undefined} title={waitsForStop ? PRACTICE_COPY.stopFirst : "Practice short (S)"} onClick={props.onShort}>Short (S)</button>
        <button type="button" className={styles.button} disabled={disabled || entering} title="Exit the open practice trade (X)" onClick={props.onExit}>Exit (X)</button>
      </div>
      <div className={styles.buttonRow}>
        <button
          type="button"
          className={styles.button}
          disabled={disabled || entering}
          title="Stop note (T)"
          onClick={() => ((draft.stopPrice ?? "").trim() === "" ? onComposer("stop") : props.onStop(draft.stopPrice ?? ""))}
        >
          Stop (T)
        </button>
        <button type="button" className={styles.button} disabled={disabled} title="Note (N)" onClick={() => onComposer("note")}>Note (N)</button>
      </div>
      {composer && <ComposerForm key={composer} composer={composer} lastPrice={lastPrice} onStop={props.onStop} onNote={props.onNote} onClose={() => onComposer(null)} />}
      <p className={styles.footnote}>{swing?.tape === "off" ? PRACTICE_COPY.swingTapeOffFootnote : PRACTICE_COPY.priceFootnote}</p>
    </div>
  );
}
