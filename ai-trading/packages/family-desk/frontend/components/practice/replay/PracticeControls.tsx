"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { FactList } from "@/components/ui/FactList";
import { RailList } from "@/components/ui/RailList";
import { Segmented } from "@/components/ui/Segmented";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { formatEtDateClock, formatPrice, signToneAt } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import type { OpenSide } from "@/lib/replay/keys";
import { formatSignedUsd } from "@/lib/desk/mask";
import { formatR } from "@/lib/replay/journalView";
import { noteMark, stopMark } from "@/lib/replay/markInput";
import type { OpenTrade, PracticeOrder } from "@/lib/replay/schemas";
import { orderLine, orderStatusText, TICKET_TYPES, TIF_OPTIONS, ticketSummary, typeOption, type TicketDraft, type TicketField, type TicketSide, type TicketType, type TimeInForce } from "@/lib/replay/ticket";
import styles from "./replay.module.css";

export type Composer = "stop" | "note" | null;

export type PracticeControlsProps = {
  symbol: string;
  side: OpenSide;
  openTrade: OpenTrade | null;
  ticket: TicketDraft;
  onTicket: (ticket: TicketDraft) => void;
  /** Why the last submit failed, with its sentence: a field of the ticket, or "order" for the order as a whole (the server named no field). Cleared when the ticket changes. */
  ticketError: { field: TicketField | "type" | "order"; message: string } | null;
  /** The ticket as it stands costs more than the buying power: said under the summary, and Buy and Sell stay off until the order fits. Null when it fits. */
  buyingPower: string | null;
  /** An order is on its way to the server: the Buy or Sell button shows it. */
  placing: boolean;
  /** Place the ticket as a buy or a sell (the submit button). */
  onSubmit: (side: TicketSide) => void;
  /** Every order of the lane; the working ones can be cancelled. */
  orders: PracticeOrder[];
  onCancelOrder: (id: number) => void;
  /** When the open trade was entered (its entry mark); null when unknown. It can be days ago: a position stays open through the close, the night and a Jump. */
  since: string | null;
  /** Closed trades only: what is already banked. The header's Practice P/L adds the open trade to it. */
  realized: number;
  /** Closed trades plus the open trade at the last price. */
  pnl: number;
  composer: Composer;
  onComposer: (composer: Composer) => void;
  onExit: () => void;
  /** Resolve true when the server took it; the form stays open on a refusal, with what she typed. */
  onStop: (price: string) => Promise<boolean>;
  onNote: (text: string) => Promise<boolean>;
  /** Nothing to mark: the thread is closed, the lane is behind the thread clock, or this is a legacy session that ended. */
  disabled: boolean;
};

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
        {since && <span className={styles.muted}>{` · since ${formatEtDateClock(since, { seconds: false })}`}</span>}
      </p>
      <FactList
        label="Open position"
        columns={2}
        facts={[
          { id: "avg", label: "Avg price", value: formatPrice(trade.entry_price) },
          { id: "stop", label: "Stop", value: trade.stop_price == null ? "None" : formatPrice(trade.stop_price) },
          { id: "last", label: "Last", value: formatPrice(trade.last_price) },
          { id: "unrealized", label: "Unrealized", value: `${formatSignedUsd(trade.unrealized_usd, { cents: true })}${trade.r != null ? ` · ${formatR(trade.r)}` : ""}`, tone: signToneAt(trade.unrealized_usd, 2) },
        ]}
      />
      {/* A stop is an alert line: once a bar crossed it this says so, and the position stays open until she closes it or an order of hers fills. */}
      {trade.stop_hit_at != null && <p className={styles.muted} data-testid="stop-crossed">{practiceText("positionStopCrossed", { time: formatEtDateClock(trade.stop_hit_at, { seconds: false }) })}</p>}
      <p className={styles.muted}>{`Realized so far ${formatSignedUsd(realized, { cents: true })} · P/L ${formatSignedUsd(pnl, { cents: true })}`}</p>
    </div>
  );
}

/**
 * The stop or note form. It mounts when opened (key = which one), starts empty (a prefilled last price is a stop that no long can
 * hold), and stays open until the server answers: a refusal leaves what she typed and the toast says why. Escape closes it from
 * the field too.
 */
function ComposerForm({ composer, onStop, onNote, onClose }: { composer: Exclude<Composer, null>; onStop: (price: string) => Promise<boolean>; onNote: (text: string) => Promise<boolean>; onClose: () => void }) {
  const [stopText, setStopText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const stopFieldId = useId();
  const noteFieldId = useId();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const built = composer === "stop" ? stopMark(stopText) : noteMark(noteText);
    if (!built.ok) {
      setError(composer === "stop" ? PRACTICE_COPY.stopNeeded : built.message);
      return;
    }
    setError(null);
    setSaving(true);
    const accepted = await (composer === "stop" ? onStop(stopText) : onNote(noteText));
    setSaving(false);
    if (accepted) onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    // Only the form closes: the drawer it sits in (1180) and full screen listen on the document and must not also act on this Escape.
    event.nativeEvent.stopImmediatePropagation();
    onClose();
  };
  return (
    <form className={styles.composer} onSubmit={(event) => void submit(event)} onKeyDown={onKeyDown} aria-label={composer === "stop" ? PRACTICE_COPY.stopLabel : "Practice note"}>
      {composer === "stop" ? (
        <Field id={stopFieldId} label={PRACTICE_COPY.stopLabel} error={error}>
          <Input autoFocus inputMode="decimal" value={stopText} onChange={(event) => { setStopText(event.target.value); setError(null); }} />
        </Field>
      ) : (
        <Field id={noteFieldId} label={PRACTICE_COPY.noteLabel} error={error}>
          <Textarea autoFocus rows={3} maxLength={280} value={noteText} onChange={(event) => { setNoteText(event.target.value); setError(null); }} />
        </Field>
      )}
      <div className={styles.pair}>
        <Button type="submit" variant="primary" size="touch" loading={saving}>Save</Button>
        <Button size="touch" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

/**
 * The order ticket and the position (02o §a3), laid out the way a broker lays them out: a side, a quantity and an order type,
 * the price fields that type needs and no others, one Buy or Sell button; below it the working orders, then the open position
 * with its Close position and Set stop. A Buy or Sell is a fill against the position: with a position open it adds to it, sells
 * part of it, or flips it, and nothing but the cash limits that. A stop is never required. Marks are priced by the server at the
 * thread's time; a limit, stop or stop-limit order waits on the replayed tape and fills when the clock crosses its price, also inside a Jump. It rests
 * until it fills or she cancels it (GTC), or lapses at the extended close of its session (Day).
 */
export function PracticeControls(props: PracticeControlsProps) {
  const { symbol, side, openTrade, ticket, onTicket, ticketError, buyingPower, placing, composer, onComposer, disabled } = props;
  const option = typeOption(ticket.type);
  const sharesId = useId();
  const typeId = useId();
  const limitId = useId();
  const stopId = useId();
  const tifId = useId();
  const summaryId = useId();
  const powerId = useId();
  const errorOf = (field: TicketField) => (ticketError?.field === field ? ticketError.message : null);
  const edit = (changes: Partial<TicketDraft>) => onTicket({ ...ticket, ...changes });
  const [allOrders, setAllOrders] = useState(false);
  const working = props.orders.filter((order) => order.status === "working");
  const finished = props.orders.filter((order) => order.status !== "working").reverse();
  const earlier = Math.max(0, finished.length - RECENT_ORDERS);
  const listed = [...working, ...(allOrders ? finished : finished.slice(0, RECENT_ORDERS))];
  // Focus belongs somewhere after a form closes or a working order goes: the button that opened the form, and the ticket.
  const stopOpener = useRef<HTMLButtonElement>(null);
  const noteOpener = useRef<HTMLButtonElement>(null);
  const ticketRegion = useRef<HTMLElement>(null);
  const wasComposer = useRef<Composer>(null);
  useEffect(() => {
    const was = wasComposer.current;
    wasComposer.current = composer;
    if (was !== null && composer === null) (was === "stop" ? stopOpener : noteOpener).current?.focus();
  }, [composer]);
  const buying = ticket.side === "buy";
  return (
    <div className={styles.controls}>
      <section ref={ticketRegion} tabIndex={-1} className={styles.ticket} aria-label="Order ticket">
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
        {(option.limit || option.stop) && (
          <Field id={tifId} label={PRACTICE_COPY.ticketTif}>
            <Select value={ticket.tif} onChange={(event) => edit({ tif: event.target.value as TimeInForce })}>
              {TIF_OPTIONS.map((tif) => (
                <option key={tif.value} value={tif.value}>{tif.label}</option>
              ))}
            </Select>
          </Field>
        )}
        <p id={summaryId} className={styles.summary}>{ticketSummary(ticket, symbol)}</p>
        <p id={powerId} className={styles.ticketError} aria-live="polite">{buyingPower}</p>
        <p className={styles.ticketError} role="alert">{ticketError?.field === "order" ? ticketError.message : null}</p>
        <Button
          variant={buying ? "up" : "down"}
          size="touch"
          className={styles.submit}
          disabled={disabled || buyingPower !== null}
          loading={placing}
          aria-describedby={buyingPower === null ? summaryId : `${summaryId} ${powerId}`}
          onClick={() => props.onSubmit(ticket.side)}
        >
          {buying ? "Buy" : "Sell"}
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
                <Button
                  size="touch"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Cancel order: ${orderLine(order)}`}
                  onClick={() => {
                    ticketRegion.current?.focus(); // the row goes when the server answers: keep focus on the ticket, not on the page
                    props.onCancelOrder(order.id);
                  }}
                >
                  Cancel
                </Button>
              ) : undefined,
            }))}
          />
          {earlier > 0 && (
            <Button size="md" variant="ghost" aria-expanded={allOrders} onClick={() => setAllOrders(!allOrders)}>
              {allOrders ? PRACTICE_COPY.ordersFewer : practiceText("ordersEarlier", { count: earlier })}
            </Button>
          )}
        </section>
      )}

      <section className={styles.position} aria-label="Position">
        <PositionCard trade={openTrade} since={props.since} realized={props.realized} pnl={props.pnl} />
        {side !== "flat" && (
          <div className={styles.pair}>
            <Button size="touch" disabled={disabled} onClick={props.onExit}>Close position</Button>
            <Button ref={stopOpener} size="touch" disabled={disabled} onClick={() => onComposer("stop")}>Set stop</Button>
          </div>
        )}
      </section>
      {composer && <ComposerForm key={composer} composer={composer} onStop={props.onStop} onNote={props.onNote} onClose={() => onComposer(null)} />}
      <div className={styles.footRow}>
        <Button ref={noteOpener} variant="ghost" size="lg" disabled={disabled} onClick={() => onComposer("note")}>Add note</Button>
        <p className={styles.footnote}>{PRACTICE_COPY.priceFootnote}</p>
      </div>
    </div>
  );
}
