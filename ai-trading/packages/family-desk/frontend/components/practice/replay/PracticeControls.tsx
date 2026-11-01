"use client";

import { useId, useState, type FormEvent } from "react";
import play from "@/components/practice/swing/play.module.css";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { RailList } from "@/components/ui/RailList";
import { Segmented } from "@/components/ui/Segmented";
import { SwingOpenTradeCard } from "@/components/practice/swing/SwingOpenTradeCard";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { changeTone, formatEtClock, formatPrice } from "@/lib/desk/format";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { OpenSide } from "@/lib/replay/keys";
import { formatSignedUsd } from "@/lib/desk/mask";
import { formatR } from "@/lib/replay/journalView";
import type { OpenTrade, PracticeOrder } from "@/lib/replay/schemas";
import { orderLine, orderStatusText, TICKET_TYPES, ticketSummary, typeOption, type TicketDraft, type TicketField, type TicketSide, type TicketType } from "@/lib/replay/ticket";
import styles from "./replay.module.css";

export type Composer = "stop" | "note" | null;

/** Swing session only (02p b2): the practice-hold card and the cash line. */
export type SwingControls = {
  tape: "on" | "off";
  /** "Free cash $24,720" */
  cash: string;
};

export type PracticeControlsProps = {
  symbol: string;
  side: OpenSide;
  openTrade: OpenTrade | null;
  lastPrice: number | null;
  ticket: TicketDraft;
  onTicket: (ticket: TicketDraft) => void;
  /** The field the last submit found wrong, with its sentence; cleared when that field changes. */
  ticketError: { field: TicketField | "type"; message: string } | null;
  /** Place the ticket as a buy or a sell (the submit button, and the B and S keys). */
  onSubmit: (side: TicketSide) => void;
  /** Every order of the session; the working ones can be cancelled. */
  orders: PracticeOrder[];
  onCancelOrder: (id: number) => void;
  /** When the open trade was entered (its entry mark); null when unknown. */
  since: string | null;
  /** Closed trades only: what is already banked. The header's Practice P/L adds the open trade to it. */
  realized: number;
  /** Closed trades plus the open trade at the last price. */
  pnl: number;
  composer: Composer;
  onComposer: (composer: Composer) => void;
  onExit: () => void;
  onStop: (price: string) => void;
  onNote: (text: string) => void;
  /** No session to mark: loading, or the session already ended. */
  disabled: boolean;
  swing?: SwingControls;
};

/** A hotkey chip: shown, never read (the button names itself and `aria-keyshortcuts` carries the key). */
const Key = ({ children }: { children: string }) => <kbd className={styles.kbd} aria-hidden="true">{children}</kbd>;

const RECENT_ORDERS = 3;

function PositionCard({ trade, since, realized, pnl }: { trade: OpenTrade | null; since: string | null; realized: number; pnl: number }) {
  if (!trade) return <p className={styles.muted}>No open position</p>;
  return (
    <div className={styles.openTrade}>
      <div className={styles.tradeHead}>
        <h3 className={styles.tradeTitle}>Position</h3>
        <SimulatedBadge />
      </div>
      <p className={styles.tradeLine}>
        {`${trade.side === "long" ? "Long" : "Short"} · ${trade.shares} shares`}
        {since && <span className={styles.muted}>{` · since ${formatEtClock(since)}`}</span>}
      </p>
      <dl className={styles.tradeCard} aria-label="Open position">
        <div><dt>Entry</dt><dd>{formatPrice(trade.entry_price)}</dd></div>
        <div><dt>Stop</dt><dd>{trade.stop_price == null ? "none" : formatPrice(trade.stop_price)}</dd></div>
        <div><dt>Last</dt><dd>{formatPrice(trade.last_price)}</dd></div>
        <div>
          <dt>Unrealized</dt>
          <dd data-tone={changeTone(trade.unrealized_usd)}>{formatSignedUsd(trade.unrealized_usd, { cents: true })}{trade.r != null && ` · ${formatR(trade.r)}`}</dd>
        </div>
      </dl>
      <p className={styles.muted}>{`Realized so far ${formatSignedUsd(realized, { cents: true })} · P/L ${formatSignedUsd(pnl, { cents: true })}`}</p>
    </div>
  );
}

/** The stop or note form. It mounts when opened (key = which one), so its fields start from the last price or empty. */
function ComposerForm({ composer, lastPrice, onStop, onNote, onClose }: { composer: Exclude<Composer, null>; lastPrice: number | null; onStop: (price: string) => void; onNote: (text: string) => void; onClose: () => void }) {
  const [stopText, setStopText] = useState(lastPrice == null ? "" : String(lastPrice));
  const [noteText, setNoteText] = useState("");
  const stopFieldId = useId();
  const noteFieldId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (composer === "stop") onStop(stopText);
    else onNote(noteText);
    onClose();
  };
  return (
    <form className={styles.composer} onSubmit={submit} aria-label={composer === "stop" ? "Stop" : "Practice note"}>
      {composer === "stop" ? (
        <Field id={stopFieldId} label="Stop price" optional>
          <Input autoFocus inputMode="decimal" value={stopText} onChange={(event) => setStopText(event.target.value)} />
        </Field>
      ) : (
        <Field id={noteFieldId} label="Note" optional>
          <Textarea autoFocus rows={3} maxLength={280} value={noteText} onChange={(event) => setNoteText(event.target.value)} />
        </Field>
      )}
      <div className={styles.pair}>
        <Button type="submit" variant="primary">Save</Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

/**
 * The order ticket and the position (02o §a3), laid out the way a broker lays them out: a side, a quantity and an order type,
 * the price fields that type needs and no others, one Buy or Sell button; below it the working orders, then the open position
 * with its Close position and Set stop. A stop is never required. Marks are priced by the server at the playhead; a limit,
 * stop or stop-limit order waits on the replayed tape and fills only on a later bar.
 */
export function PracticeControls(props: PracticeControlsProps) {
  const { symbol, side, openTrade, lastPrice, ticket, onTicket, ticketError, composer, onComposer, disabled, swing } = props;
  const option = typeOption(ticket.type);
  const sharesId = useId();
  const typeId = useId();
  const limitId = useId();
  const stopId = useId();
  const summaryId = useId();
  const errorOf = (field: TicketField) => (ticketError?.field === field ? ticketError.message : null);
  const edit = (changes: Partial<TicketDraft>) => onTicket({ ...ticket, ...changes });
  const working = props.orders.filter((order) => order.status === "working");
  const recent = props.orders.filter((order) => order.status !== "working").slice(-RECENT_ORDERS).reverse();
  const listed = [...working, ...recent];
  const buying = ticket.side === "buy";
  return (
    <div className={styles.controls}>
      <section className={styles.ticket} aria-label="Order ticket">
        {swing && <dl className={play.card} aria-label="Free cash"><div><dt>Free cash</dt><dd>{swing.cash.replace(/^Free cash\s+/, "")}</dd></div></dl>}
        <Segmented
          size="touch"
          fill
          label="Side"
          value={ticket.side}
          onChange={(next) => edit({ side: next })}
          options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]}
        />
        <div className={styles.fields}>
          <Field id={sharesId} label="Quantity" error={errorOf("shares")}>
            <Input inputMode="numeric" value={ticket.shares} onChange={(event) => edit({ shares: event.target.value })} />
          </Field>
          <Field id={typeId} label="Order type" error={ticketError?.field === "type" ? ticketError.message : null}>
            <Select value={ticket.type} onChange={(event) => edit({ type: event.target.value as TicketType })}>
              {TICKET_TYPES.map((type) => (
                <option key={type.value} value={type.value} disabled={type.unavailable !== undefined}>{type.unavailable ?? type.label}</option>
              ))}
            </Select>
          </Field>
        </div>
        {(option.limit || option.stop) && (
          <div className={styles.fields}>
            {option.stop && (
              <Field id={stopId} label="Stop price" error={errorOf("stopPrice")}>
                <Input inputMode="decimal" value={ticket.stopPrice} onChange={(event) => edit({ stopPrice: event.target.value })} />
              </Field>
            )}
            {option.limit && (
              <Field id={limitId} label="Limit price" error={errorOf("limitPrice")}>
                <Input inputMode="decimal" value={ticket.limitPrice} onChange={(event) => edit({ limitPrice: event.target.value })} />
              </Field>
            )}
          </div>
        )}
        <p id={summaryId} className={styles.summary}>{ticketSummary(ticket, symbol)}</p>
        <Button
          variant={buying ? "up" : "down"}
          size="touch"
          className={styles.submit}
          disabled={disabled}
          aria-keyshortcuts={buying ? "B" : "S"}
          aria-describedby={summaryId}
          onClick={() => props.onSubmit(ticket.side)}
        >
          {buying ? "Buy" : "Sell"}
          <Key>{buying ? "B" : "S"}</Key>
        </Button>
      </section>

      {listed.length > 0 && (
        <section className={styles.orders} aria-label="Orders">
          <h3 className={styles.sectionTitle}>Orders</h3>
          <RailList
            size="md"
            divided
            label="Orders"
            rows={listed.map((order) => ({
              id: String(order.id),
              label: orderLine(order),
              sub: orderStatusText(order),
              value: order.status === "working" ? (
                <Button size="md" variant="ghost" disabled={disabled} aria-label={`Cancel order: ${orderLine(order)}`} onClick={() => props.onCancelOrder(order.id)}>Cancel</Button>
              ) : undefined,
            }))}
          />
        </section>
      )}

      <section className={styles.position} aria-label="Position">
        {swing ? <SwingOpenTradeCard trade={openTrade} tape={swing.tape} /> : <PositionCard trade={openTrade} since={props.since} realized={props.realized} pnl={props.pnl} />}
        {side !== "flat" && (
          <div className={styles.pair}>
            <Button disabled={disabled} aria-keyshortcuts="X" onClick={props.onExit}>
              Close position
              <Key>X</Key>
            </Button>
            <Button disabled={disabled} aria-keyshortcuts="T" onClick={() => onComposer("stop")}>
              Set stop
              <Key>T</Key>
            </Button>
          </div>
        )}
      </section>
      {composer && <ComposerForm key={composer} composer={composer} lastPrice={lastPrice} onStop={props.onStop} onNote={props.onNote} onClose={() => onComposer(null)} />}
      <div className={styles.footRow}>
        <Button variant="ghost" size="md" disabled={disabled} aria-keyshortcuts="N" onClick={() => onComposer("note")}>
          Add note
          <Key>N</Key>
        </Button>
        <p className={styles.footnote}>{swing?.tape === "off" ? PRACTICE_COPY.swingTapeOffFootnote : PRACTICE_COPY.priceFootnote}</p>
      </div>
    </div>
  );
}
