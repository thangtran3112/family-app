"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PracticeTabs } from "@/components/practice/hub/PracticeTabs";
import { ThreadStrip } from "@/components/practice/thread/ThreadStrip";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { LeftRailPortal } from "@/components/shell/desktop/LeftRailPortal";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail, type RailSection } from "@/components/shell/desktop/RightRail";
import { Button } from "@/components/ui/Button";
import { ThreadPicker } from "@/components/practice/journal/thread/ThreadPicker";
import { PracticeNotice } from "@/components/practice/PracticeNotice";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { TabPanel, Tabs } from "@/components/ui/Tabs";
import { currentValue } from "@/lib/chart-data";
import { isSpeed } from "@/lib/replay/clock";
import { formatEtDateClock, formatEtDay, formatEtTimeZone } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { screenHref, threadPageHref } from "@/lib/replay/practiceTabs";
import { openRailTab } from "@/lib/desk/rail";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { buildChartSeries } from "@/lib/desk/workspace";
import { readChartPrefs, togglePref, writeChartPrefs, type ChartPrefs, type PrefId } from "@/lib/replay/chartPrefs";
import { entrySince, levelRows, markRows, openSide } from "@/lib/replay/marks";
import { practicePnl } from "@/lib/replay/planView";
import type { ReplaySession } from "@/lib/replay/schemas";
import { routeId } from "@/lib/replay/routeId";
import { replayStatusLine } from "@/lib/replay/statusLine";
import { chartOrderDraft } from "@/lib/replay/chartOrder";
import { buildTicket, buyingPowerMessage, initialTicket, type PowerBasis, type TicketDraft, type TicketField } from "@/lib/replay/ticket";
import { etDayOf } from "@/lib/replay/time";
import { useReplaySession, type ReplaySessionApi } from "@/lib/replay/useReplaySession";
import { useShownClock } from "@/lib/replay/useShownClock";
import { serverSeries } from "@/lib/replay/serverIndicators";
import { chartBars, viewClock, type ReplayView } from "@/lib/replay/feedState";
import { ChartSettings, FullScreenButton } from "./ChartSettings";
import { ChartToolbar } from "./ChartToolbar";
import { LevelsList } from "./LevelsList";
import { MarksList } from "./MarksList";
import { PracticeControls, type Composer } from "./PracticeControls";
import { REPLAY_INDICATORS, ReplayChart } from "./ReplayChart";
import { IndicatorsPanel } from "./IndicatorsPanel";
import { ReplayHeader } from "./ReplayHeader";
import { ReplayToast } from "./ReplayToast";
import { SignalsRail, signalKey } from "./SignalsRail";
import { TapePanel } from "./TapePanel";
import styles from "./replay.module.css";

const BOTTOM_TABS_ID = "replay-bottom";

/** `/practice/replay?id=`: one LANE of a freestyle thread (ADR-0025): the chart, the tape and the ticket of one name, at the thread's time `T`. The id is
 *  the lane's. Reads the URL, so the page wraps it in Suspense. */
export function ReplayWorkspace() {
  const params = useSearchParams();
  const { id, given } = routeId(params.get("id"));

  if (id === null) {
    return (
      <div className={styles.page}>
        {given ? <PracticeNotice title={PRACTICE_COPY.sessionNotFound} /> : <ThreadPicker hint={PRACTICE_COPY.threadPickHintReplay} href={threadPageHref} />}
      </div>
    );
  }
  // A new id is a fresh workspace: nothing of the old lane carries over.
  return <ReplayById key={id} id={id} />;
}

function ReplayById({ id }: { id: number }) {
  const api = useReplaySession(id);
  if (api.notFound) return <div className={styles.page}><PracticeNotice title={PRACTICE_COPY.sessionNotFound} /></div>;
  if (api.loadError) return <div className={styles.page}><ErrorBlock message={PRACTICE_COPY.loadError} onRetry={api.reload} /></div>;
  if (api.loading || !api.session || !api.view) return <div className={styles.page}><LoadingBlock label={PRACTICE_COPY.loadingReplay} height={420} /></div>;
  return <ReplayLoaded api={api} session={api.session} view={api.view} />;
}

function ReplayLoaded({ api, session, view }: { api: ReplaySessionApi; session: ReplaySession; view: ReplayView }) {
  const band = useShellBand();
  const { spec } = session;
  const threadId = session.thread_id;
  // A lane of a closed thread, and a legacy standalone session that ended, are read as they were left: nothing can be ordered on them. A lane never
  // ends on its own (ADR-0025): no close, night or Jump ends it.
  const locked = session.status === "ended" || session.thread?.status === "closed";
  // The order ticket: a side, a quantity, an order type with the prices that type takes, and (for a working order) its time in force. A stop is never part of it.
  const [ticket, setTicket] = useState<TicketDraft>(() => initialTicket(spec.shares));
  const [ticketError, setTicketError] = useState<{ field: TicketField | "type" | "order"; message: string } | null>(null);
  const [placing, setPlacing] = useState(false);
  // What the ticket can tell of the buying power before it sends: the thread's balance and this name's position (the server holds the exact cash).
  const powerBasis: PowerBasis | null = session.thread ? { balance: session.thread.balance, trade: view.openTrade, last: view.last?.price ?? null } : null;
  const buyingPower = buyingPowerMessage(ticket, powerBasis);
  const editTicket = (next: TicketDraft) => {
    setTicket(next);
    setTicketError(null);
  };
  const [composer, setComposer] = useState<Composer>(null);
  // The chart's own view settings (design-replay-chart §b): one object for this browser, read once (the desktop shell mounts on the client only).
  const [prefs, setPrefs] = useState<ChartPrefs>(() => readChartPrefs(window.localStorage));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const updatePrefs = (next: ChartPrefs) => {
    setPrefs(next);
    writeChartPrefs(window.localStorage, next);
  };
  // Full screen is a view state of this route, never a navigation: the shell hides its top bar, left rail and status bar while it is on,
  // and it is reset when this screen goes away (Back, another name), so the shell is never left in focus mode.
  const [full, setFull] = useState(false);
  const { setChartFocus } = useDeskUi();
  useEffect(() => {
    setChartFocus(full);
    return () => setChartFocus(false);
  }, [full, setChartFocus]);
  // At the 1180 band the right rail is a tab strip; each tab opens its own drawer and none closes another (D-020).
  const [railOpen, setRailOpen] = useState<string[]>([]);
  const [bottomTab, setBottomTab] = useState<"marks" | "levels">("marks");
  const [bottomOpen, setBottomOpen] = useState<boolean | null>(null);
  const [focus, setFocus] = useState<{ time: string; at: number } | null>(null);
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);
  const side = openSide(view.openTrade);
  const pnl = practicePnl(session.journal, view.openTrade);
  // The thread's clock runs on the server and is controlled from the Summary: this screen has no transport at all (ADR-0018, ADR-0025).
  const followed = api.follows;
  const behind = view.behindClock && !locked;
  // The thread's one time: the payload's own `thread_time` (ADR-0022), uncapped, so past the tape it keeps counting while the chart's data stands still.
  const clock = viewClock(view);
  // What a lane's chart SHOWS of that time ticks every second between two polls; the readout, the status bar and the top-bar chip all read this one
  // value (D-166). `clock` stays the polled time for everything that prices or compares. While the polls fail (`api.stale`) the readout is held, as the Summary's is.
  const ticking = useShownClock(clock, followed && view.clockRunning && !api.stale, isSpeed(view.clockSpeed) ? view.clockSpeed : 1);
  const shownClock = followed ? ticking : clock;

  // The band and the status bar name the ET date of the thread's time: a label that follows T, never a day she is "in".
  useReportPracticeChrome({ day: etDayOf(shownClock), playhead: shownClock, status: replayStatusLine(session.tape_feed === "iex" ? "iex" : "sip", shownClock) });

  // The chart's bars and series are built once: the chart draws them, the header reads VWAP from the same series and the left rail reads the same rows.
  // EMA 9/21, VWAP, RSI and MACD are the server's, computed from the same cut as the price and the forming candle (ADR-0022): the browser computes none
  // of them and asks for no one-minute feed, so the header, the left rail and the chart cannot disagree on 1m, 5m and 15m.
  // They depend on the closed bars, the forming candle and the server's rows, not on the whole view: a poll that brings nothing new changes the view (the clock, the tape)
  // but none of these, so the chart is handed the very same arrays and redraws nothing (D-206).
  const { bars: closedBars, forming, indicators } = view;
  const bars = useMemo(() => chartBars({ bars: closedBars, forming }), [closedBars, forming]);
  const server = useMemo(() => serverSeries(bars, indicators, view.interval, forming?.t ?? null), [bars, indicators, view.interval, forming]);
  const series = useMemo(() => buildChartSeries(bars, REPLAY_INDICATORS, view.interval, "stock", server), [bars, view.interval, server]);
  const vwap = currentValue(series.overlays.find((overlay) => overlay.id === "vwap")?.values ?? []);

  const openComposer = (next: Composer) => {
    setComposer(next);
    if (next && band === "1180") setRailOpen((open) => openRailTab(open, "practice"));
  };

  /**
   * Buy or Sell as the ticket stands: a market entry, or a limit, stop or stop-limit order that waits on the tape. A click on the
   * chart's price (`chartDraft`) sends the ticket's quantity with the type and price that click means, through this same path, and
   * leaves the ticket's own draft as she had it. Resolves true when the server took it.
   */
  const submitTicket = (chosen: "buy" | "sell", chartDraft?: TicketDraft): Promise<boolean> => {
    const draft = chartDraft ?? { ...ticket, side: chosen };
    const built = buildTicket(draft);
    const tooBig = built.ok ? buyingPowerMessage(draft, powerBasis) : null;
    if (!built.ok || tooBig !== null) {
      if (!chartDraft) setTicket((current) => ({ ...current, side: chosen }));
      setTicketError(built.ok ? { field: "shares", message: tooBig! } : { field: built.field, message: built.message });
      if (band === "1180") setRailOpen((open) => openRailTab(open, "practice")); // the message sits at the field
      return Promise.resolve(false);
    }
    setTicketError(null);
    // A failed order is said on the ticket, with the server's own sentence. The server names the field it refused (not enough cash is the
    // Quantity's): the message then sits at that field, as a typed one does. A chart order's price is not a ticket field the ticket shows
    // (its type is market), and some failures name no field at all: those sit on the ticket as a whole, and in the chart popup.
    const refused = (path: string, message: string) => {
      const shown = chartDraft ? path === "shares" : path === "shares" || path === "limitPrice" || path === "stopPrice";
      setTicketError({ field: shown ? (path as TicketField) : "order", message });
      if (band === "1180") setRailOpen((open) => openRailTab(open, "practice")); // the ticket is in the drawer
      return true;
    };
    setPlacing(true);
    return api.ticket(built.action, refused).then((accepted) => {
      if (accepted && !chartDraft) setTicket((current) => ({ ...current, side: chosen, limitPrice: "", stopPrice: "" })); // the quantity and the time in force stay as set
      return accepted;
    }).finally(() => setPlacing(false));
  };
  const placeMark = (kind: Parameters<ReplaySessionApi["mark"]>[0]) => {
    if (kind === "long_entry" || kind === "short_entry") {
      void submitTicket(kind === "long_entry" ? "buy" : "sell");
      return;
    }
    void api.mark(kind, {});
  };
  /**
   * The Buy, Sell and Close position buttons (there are no keys). Buy and Sell send the ticket as it stands and the server nets it
   * against the position; Close exits the whole open side. The buttons are off while the name is behind the thread clock or the thread
   * is closed; this says so instead of marking anyway.
   */
  const order = (choice: "buy" | "sell" | "close") => {
    if (locked || behind) {
      api.notify("info", locked ? (threadId !== null ? PRACTICE_COPY.markThreadClosed : PRACTICE_COPY.markEnded) : practiceText("laneMarkBehind", { symbol: spec.symbol }));
      return;
    }
    if (choice === "close") {
      if (side !== "flat") placeMark(side === "long" ? "long_exit" : "short_exit");
      return;
    }
    placeMark(choice === "buy" ? "long_entry" : "short_entry");
  };

  // Escape is the one key left, and it is the browser's own habit for a full-screen view: it leaves full screen. The settings popover and
  // the stop or note form handle their own Escape first (they stop the key before it gets here).
  useEffect(() => {
    if (!full) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setFull(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [full]);

  const dateLabel = formatEtDay(etDayOf(shownClock));
  const bottomShown = bottomOpen ?? band === "1440";
  const realized = practicePnl(session.journal, null);

  // The panel opens and closes only when she asks, so a mark never moves the chart (D-146). A panel left closed still names the
  // newest mark in its tab row, so a mark she just placed is visible without Expand (D-028).
  const newestMark = markRows(session.marks)[0] ?? null;

  // Click-to-order on the chart: only while she could use the ticket's buttons, and once there is a print to price against.
  const lastPrice = view.last?.price ?? null;
  const chartOrder = locked || behind || lastPrice === null
    ? undefined
    : { shares: ticket.shares, tif: ticket.tif, place: (chosen: "buy" | "sell", price: number) => submitTicket(chosen, chartOrderDraft(ticket, chosen, price, lastPrice)), error: ticketError?.message ?? null };

  const controls = (
    <PracticeControls
      symbol={spec.symbol}
      side={side}
      openTrade={view.openTrade}
      ticket={ticket}
      onTicket={editTicket}
      ticketError={ticketError}
      buyingPower={buyingPower}
      placing={placing}
      onSubmit={order}
      orders={session.orders}
      onCancelOrder={api.cancelOrder}
      since={entrySince(session.marks, view.openTrade)}
      realized={realized}
      pnl={pnl}
      composer={composer}
      onComposer={openComposer}
      onExit={() => order("close")}
      onStop={api.stopNote}
      onNote={api.note}
      disabled={locked || behind}
    />
  );
  // The crosshair goes to the display bar open one second before the signal's bar close.
  const focusSignal = useCallback(
    (barClose: string) => {
      const target = Date.parse(barClose) - 1000;
      const start = [...view.bars, ...(view.forming ? [view.forming] : [])].filter((bar) => Date.parse(bar.t) <= target).at(-1);
      if (start) setFocus({ time: start.t, at: Date.now() });
    },
    [view.bars, view.forming],
  );

  const signalsRail = <SignalsRail
      signals={view.signals}
      selectedKey={selectedSignal}
      onSelect={(signal) => {
        setSelectedSignal(signalKey(signal));
        focusSignal(signal.bar_close);
      }}
    />;

  // The right rail is the order side of the workspace: the ticket (Practice) and the signals. The tape is the left rail's.
  const sections: RailSection[] = [
    { id: "practice", label: "Practice", node: controls },
    { id: "signals", label: "Signals", node: signalsRail },
  ];

  const quick = band === "1180" ? (
    <span className={styles.quick} role="group" aria-label="Practice buttons">
      <Button variant="up" size="md" disabled={locked || behind} onClick={() => order("buy")}>Buy</Button>
      <Button variant="down" size="md" disabled={locked || behind} onClick={() => order("sell")}>Sell</Button>
      <Button size="md" disabled={locked || behind || side === "flat"} onClick={() => order("close")}>Close position</Button>
    </span>
  ) : null;

  return (
    <div className={styles.workspace} data-drawer={band === "1180" && railOpen.length > 0 ? "open" : undefined} data-full={full ? "true" : undefined}>
      {!full && <PracticeTabs threadId={threadId ?? session.thread?.id ?? null} active={null} back={false} />}
      {/* The thread's clock is the thread's, on the server, and its controls are on the Summary: none of that is on a chart (ADR-0018, ADR-0025).
          This line is a read-only readout of it. A legacy standalone session that ended has no thread: it shows only the time it stopped at. */}
      <p className={styles.timeReadout} role="status" aria-live="off" data-testid="thread-time-readout" data-running={view.clockRunning ? "true" : "false"}>
        <span>{threadId !== null ? PRACTICE_COPY.threadTime : PRACTICE_COPY.replayTime}</span>
        <span data-testid="thread-clock-time">{formatEtDateClock(shownClock)}</span>
        {api.stale && <span role="status" className={styles.staleNote} data-testid="chart-stale">{practiceText("chartNotUpdating", { when: formatEtDateClock(view.dataThrough) })}</span>}
        {view.market?.phase === "closed" && (
          <span data-testid="market-closed">{practiceText("marketClosed", { time: formatEtTimeZone(view.dataThrough) })}</span>
        )}
        {view.market?.phase === "closed" && view.market.next_open_at !== null && (
          <span data-testid="market-next-open">{practiceText("marketNextOpen", { when: formatEtDateClock(view.market.next_open_at, { seconds: false }) })}</span>
        )}
        {threadId !== null && <span>{view.clockRunning ? practiceText("clockStateRunning", { speed: view.clockSpeed }) : PRACTICE_COPY.clockStatePaused}</span>}
        {threadId !== null && <Link href={threadPageHref(threadId)} className={styles.link}>{view.clockRunning ? PRACTICE_COPY.chartClockLinkControls : PRACTICE_COPY.chartClockLink}</Link>}
        {threadId !== null && <Link href={screenHref(threadId)} className={styles.link}>{PRACTICE_COPY.tabScreen}</Link>}
      </p>
      <ReplayHeader symbol={spec.symbol} dateLabel={dateLabel} lastPrice={view.last?.price ?? null} vwap={vwap} priorClose={view.levels.prior_close ?? null} pnl={pnl} />
      {session.thread && !full && <ThreadStrip thread={session.thread} />}
      <ReplayToast toast={api.toast} onDismiss={api.dismissToast} onHold={api.holdToast} onRelease={api.releaseToast} />
      {behind && view.threadClock && (
        <p className={styles.warning} role="status" data-testid="behind-clock">
          <span>{practiceText("laneBehind", { symbol: spec.symbol, clock: formatEtTimeZone(view.threadClock) })}</span>
          <button type="button" className={styles.linkButton} disabled={api.busy} onClick={api.catchUp}>{PRACTICE_COPY.replayCatchUp}</button>
        </p>
      )}
      <div className={styles.chartSlot} data-testid="chart-slot">
        <ReplayChart symbol={spec.symbol} view={view} bars={bars} series={series} focus={focus} dimmed={Boolean(api.error) || api.stale} order={chartOrder} prefs={prefs} onTogglePref={(id: PrefId) => updatePrefs(togglePref(prefs, id))} />
      </div>
      <ChartToolbar
        symbol={spec.symbol}
        interval={view.interval}
        onInterval={api.setInterval}
        quick={quick}
        view={
          <>
            <ChartSettings open={settingsOpen} onOpenChange={setSettingsOpen} prefs={prefs} onChange={updatePrefs} />
            <FullScreenButton full={full} onToggle={() => setFull((on) => !on)} />
          </>
        }
      />
      <section className={styles.bottom} aria-label="Marks and levels" data-open={bottomShown ? "true" : "false"}>
        <div className={styles.bottomTabs}>
          <Tabs
            idBase={BOTTOM_TABS_ID}
            label="Bottom panel"
            size="md"
            track={false}
            panelMounted={bottomShown}
            value={bottomTab}
            tabs={[{ id: "marks", label: "Marks" }, { id: "levels", label: "Levels" }]}
            onChange={(tab) => {
              setBottomTab(tab);
              setBottomOpen(true);
            }}
          />
          {!bottomShown && newestMark && (
            <span className={styles.newestMark}>{[newestMark.time, newestMark.label, newestMark.price].filter((part) => part !== "").join(" · ")}</span>
          )}
          {/* One name, one state: the button is "Marks and levels panel" and `aria-expanded` says open or closed (the text no longer flips too). */}
          <Button className={styles.bottomToggle} variant="ghost" size="md" iconOnly aria-label="Marks and levels panel" aria-expanded={bottomShown} onClick={() => setBottomOpen(!bottomShown)}>
            <span aria-hidden="true">{bottomShown ? "▾" : "▴"}</span>
          </Button>
        </div>
        {bottomShown && (
          <TabPanel idBase={BOTTOM_TABS_ID} id={bottomTab} className={styles.bottomBody}>
            {bottomTab === "marks" ? <MarksList rows={markRows(session.marks)} /> : <LevelsList rows={levelRows(view.levels)} />}
          </TabPanel>
        )}
      </section>
      <LeftRailPortal>
        <div className={styles.session}>
          <IndicatorsPanel bars={bars} interval={view.interval} timeframe={view.interval} server={server} />
          <section className={styles.tapeSection} aria-label="Tape" data-testid="tape-panel">
            <h2 className={styles.railTitle}>Tape</h2>
            <div className={styles.tapeSlot}>
              <TapePanel view={view} filterId={api.filterId} onFilter={api.setFilter} />
            </div>
          </section>
        </div>
      </LeftRailPortal>
      <RightRail sections={sections} label="Replay context" multi openIds={railOpen} onOpenIdsChange={setRailOpen} />
    </div>
  );
}
