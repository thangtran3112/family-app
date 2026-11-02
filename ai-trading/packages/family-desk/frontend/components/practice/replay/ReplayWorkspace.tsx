"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartIntervalToggle } from "@/components/practice/swing/ChartIntervalToggle";
import { DayStrip } from "@/components/practice/swing/DayStrip";
import { StopPausedToast } from "@/components/practice/swing/StopPausedToast";
import { SwingPlanChecklist } from "@/components/practice/swing/SwingPlanChecklist";
import { useSwingContext } from "@/components/practice/swing/useSwingContext";
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
import { threadClock } from "@/lib/replay/clock";
import { etDayOf, etWallToUtcIso } from "@/lib/replay/time";
import { formatEtClock, formatEtDay, formatEtTimeZone } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { openRailTab } from "@/lib/desk/rail";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { buildChartSeries } from "@/lib/desk/workspace";
import { placeMark as sendMark, startDaySession } from "@/lib/desk/replay";
import { whenReady } from "@/lib/desk/patience";
import { endAnyDay } from "@/lib/replay/swingApi";
import { portfolioRows } from "@/lib/replay/dayView";
import { readChartPrefs, togglePref, writeChartPrefs, type ChartPrefs, type PrefId } from "@/lib/replay/chartPrefs";
import { exitMark } from "@/lib/replay/markInput";
import { entrySince, levelRows, markRows, openSide } from "@/lib/replay/marks";
import { practicePnl, tradeCount } from "@/lib/replay/planView";
import {
  SWING_PLAY_COPY,
  dailyChartModel,
  initialChartMode,
  intradayOf,
  isSwingSession,
  pauseExit,
  stripHoldCount,
  swingDayChip,
  swingMoneyLine,
  swingPlanItems,
  tapeNote,
  type ChartMode,
  type PauseExit,
} from "@/lib/replay/playView";
import type { Paused, ReplaySession } from "@/lib/replay/schemas";
import { problemMessage } from "@/lib/replay/setup";
import { replayStatusLine } from "@/lib/replay/statusLine";
import { freeCashText } from "@/lib/replay/swing";
import { chartOrderDraft } from "@/lib/replay/chartOrder";
import { buildTicket, initialTicket, type TicketDraft, type TicketField } from "@/lib/replay/ticket";
import { useReplaySession, type ReplaySessionApi } from "@/lib/replay/useReplaySession";
import { chartBars, dailyBlock, type ReplayView } from "@/lib/replay/feedState";
import { ChartSettings, FullScreenButton } from "./ChartSettings";
import { ChartToolbar } from "./ChartToolbar";
import { useDayPortfolio } from "./Portfolio";
import { EndPrompt } from "./EndPrompt";
import { LevelsList } from "./LevelsList";
import { MarksList } from "./MarksList";
import { PracticeControls, type Composer } from "./PracticeControls";
import { REPLAY_INDICATORS, ReplayChart } from "./ReplayChart";
import { IndicatorsPanel } from "./IndicatorsPanel";
import { ReplayHeader } from "./ReplayHeader";
import { ReplayToast } from "./ReplayToast";
import { SignalsRail, signalKey } from "./SignalsRail";
import { TapePanel } from "./TapePanel";
import { ThreadClockBar } from "./ThreadClockBar";
import styles from "./replay.module.css";

const BOTTOM_TABS_ID = "replay-bottom";

/** `/practice/replay?id=`: the chart, the tape and the controls (02o §a3). Reads the URL, so the page wraps it in Suspense. */
export function ReplayWorkspace() {
  const params = useSearchParams();
  const raw = params.get("id");
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;

  if (id === null) {
    return (
      <div className={styles.page}>
        <ThreadPicker />
      </div>
    );
  }
  // A new id (a swing day strip click opens another name's session) is a fresh workspace: nothing of the old one carries over.
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
  const router = useRouter();
  const band = useShellBand();
  const { spec } = session;
  const hidden = spec.hideDate === "yes";
  const ended = session.status === "ended";
  // A swing session (02p) belongs to a swing thread: the day strip, the Daily chart, the stop pause and the hold rules.
  const swing = isSwingSession(session);
  const [chartMode, setChartMode] = useState<ChartMode>(() => initialChartMode(spec.interval));
  const [opening, setOpening] = useState<string | null>(null);
  // The stop pause belongs to the playhead it stopped at: it shows until she answers or the playhead moves, so a chart
  // toggle (which re-reads the feed and drops `api.paused`) does not take the question away.
  const [pause, setPause] = useState<{ paused: Paused; at: string } | null>(null);
  // A day thread's clock stays stopped at a crossed stop until she resumes it, so every follow answer repeats the same pause: it is one
  // pause (the same name, stop and minute), and once answered it does not come back until the clock stops somewhere else.
  const [answered, setAnswered] = useState<string | null>(null);
  const pauseKey = (paused: Paused) => `${paused.symbol}|${paused.at}`;
  if (api.paused !== null && pause?.paused !== api.paused && answered !== pauseKey(api.paused) && (pause === null || pauseKey(pause.paused) !== pauseKey(api.paused))) {
    setPause({ paused: api.paused, at: view.revealedThrough });
  }
  const shownPause = pause !== null && pause.at === view.revealedThrough && session.status !== "ended" ? pause.paused : null;
  const answerPause = () => {
    if (pause !== null) setAnswered(pauseKey(pause.paused));
    setPause(null);
    api.dismissPause();
  };
  const swingContext = useSwingContext(swing ? session.thread_id : null, session.thread?.week_no, session.marks.length);
  // The order ticket: a side, a quantity and an order type with the prices that type takes. A stop is never part of it.
  const [ticket, setTicket] = useState<TicketDraft>(() => initialTicket(spec.shares));
  const [ticketError, setTicketError] = useState<{ field: TicketField | "type"; message: string } | null>(null);
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
  // and it is reset when this screen goes away (Back, another name, End day), so the shell is never left in focus mode.
  const [full, setFull] = useState(false);
  const { setChartFocus } = useDeskUi();
  useEffect(() => {
    setChartFocus(full);
    return () => setChartFocus(false);
  }, [full, setChartFocus]);
  // At the 1180 band the right rail is a tab strip; each tab opens its own drawer and none closes another (D-020).
  const [railOpen, setRailOpen] = useState<string[]>([]);
  // "Show date" is the viewer's own choice for this view; the chart stays on clock ticks (D-023).
  const [dateShown, setDateShown] = useState(false);
  const [bottomTab, setBottomTab] = useState<"marks" | "levels">("marks");
  const [bottomOpen, setBottomOpen] = useState<boolean | null>(null);
  const [dayBusy, setDayBusy] = useState(false);
  const [focus, setFocus] = useState<{ time: string; at: number } | null>(null);
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);
  const dayListId = session.day_list_id;
  const side = openSide(view.openTrade);
  const pnl = practicePnl(session.journal, view.openTrade);
  const trades = tradeCount(session.journal, view.openTrade);
  const atEnd = api.player.status === "at_end" || ended;
  // A day thread's clock runs on the server and is controlled from the Summary: this screen has no transport at all (ADR-0018).
  const followed = api.follows;
  const behind = view.behindClock && !ended;
  // The thread's one time: the day clock for a name on a day list (a name left behind it shows the thread's time, not its own old playhead).
  const clock = threadClock(view.revealedThrough, view.dayClock);
  // A day's portfolio: every name she holds, read here only for the stop-pause toast (which name to exit). The chart view shows no portfolio panel: it is the Portfolio tab's (owner, 2026-11-01).
  // The list prices every open trade at the day clock, so it is read again after a mark and whenever the clock settles (a step, a
  // jump, a stop pause), not on every bar of a running replay: each read prices up to five names.
  // While paused the clock follows the playhead; while playing it stays at the playhead it had when the replay last paused. It is
  // adjusted during render (as `pause` above is), so a paused reveal re-renders once before commit, not again after an effect.
  const playing = api.player.status === "playing";
  const [clockSeen, setClockSeen] = useState(view.revealedThrough);
  if (!playing && clockSeen !== view.revealedThrough) setClockSeen(view.revealedThrough);
  const dayList = useDayPortfolio(swing ? null : dayListId, session.marks.length * 2 + (behind ? 1 : 0) + Math.floor(Date.parse(clockSeen) / 1000));
  const dayRows = dayList.data === null ? [] : portfolioRows(dayList.data, { symbol: spec.symbol, playhead: clock, openTrade: view.openTrade });

  // An ended day session has been scored and its review shows the date, so the replay stops hiding it (D-100). A swing thread keeps its dates hidden across the block.
  const masked = hidden && !dateShown && !(ended && !swing);
  useReportPracticeChrome({ day: spec.day, hidden: masked, playhead: clock, status: replayStatusLine(session.tape_feed, clock), onShowDate: masked ? () => setDateShown(true) : null });

  // The chart's bars and series are built once: the chart draws them and the header reads VWAP from the same series.
  const bars = useMemo(() => chartBars(view), [view]);
  const series = useMemo(() => buildChartSeries(bars, REPLAY_INDICATORS, view.interval), [bars, view.interval]);
  const vwap = currentValue(series.overlays.find((overlay) => overlay.id === "vwap")?.values ?? []);
  // The left rail's indicators are read off what the chart shows: the intraday bars, or the rebased daily bars while a swing session is on Daily.
  const { daily, dailyForming } = view;
  const dailyBars = useMemo(() => {
    const block = dailyBlock({ daily, dailyForming });
    return block === null ? null : dailyChartModel(block, hidden).bars;
  }, [daily, dailyForming, hidden]);
  const indicatorBars = swing && chartMode === "daily" && dailyBars !== null ? { bars: dailyBars, interval: "1d", timeframe: "Daily" } : { bars, interval: view.interval, timeframe: view.interval };

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
    const built = buildTicket(chartDraft ?? { ...ticket, side: chosen });
    if (!built.ok) {
      if (!chartDraft) setTicket((current) => ({ ...current, side: chosen }));
      setTicketError({ field: built.field, message: built.message });
      if (band === "1180") setRailOpen((open) => openRailTab(open, "practice")); // the message sits at the field
      return Promise.resolve(false);
    }
    setTicketError(null);
    // The server names the field it refused (not enough cash is the Quantity's): the message then sits at that field, as a typed one does.
    // A chart order's price is not a ticket field the ticket shows (its type is market), so a refused price is the message line's.
    const refused = (path: string, message: string) => {
      const shown = chartDraft ? path === "shares" : path === "shares" || path === "limitPrice" || path === "stopPrice";
      if (!shown) return false;
      setTicketError({ field: path as TicketField, message });
      if (band === "1180") setRailOpen((open) => openRailTab(open, "practice")); // the field is in the drawer
      return true;
    };
    return api.ticket(built.action, refused).then((accepted) => {
      if (accepted && !chartDraft) setTicket((current) => ({ ...current, side: chosen, limitPrice: "", stopPrice: "" })); // the quantity stays as typed
      return accepted;
    });
  };
  const placeMark = (kind: Parameters<ReplaySessionApi["mark"]>[0]) => {
    if (kind === "long_entry" || kind === "short_entry") {
      void submitTicket(kind === "long_entry" ? "buy" : "sell");
      return;
    }
    void api.mark(kind, {}).then((accepted) => {
      // Closing the name whose stop paused play answers the toast.
      if (accepted && shownPause?.symbol === spec.symbol) answerPause();
    });
  };
  /**
   * The Buy, Sell and Close position buttons (there are no keys). Buy and Sell send the ticket as it stands and the server nets it
   * against the position; Close exits the whole open side. The buttons are off while the name is behind the day clock or the session
   * has ended; this says so instead of marking anyway.
   */
  const order = (choice: "buy" | "sell" | "close") => {
    if (ended || behind) {
      api.notify("info", ended ? PRACTICE_COPY.markEnded : practiceText("markBehind", { symbol: spec.symbol }));
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

  // Daily needs no request (the daily block is in the view already); 15m and 5m re-read the feed at that interval.
  const pickMode = (mode: ChartMode) => {
    setChartMode(mode);
    if (mode !== "daily" && mode !== api.interval) api.setInterval(intradayOf(mode));
  };
  /** Opens (or resumes) another name's session at the day clock and shows it in this workspace; the day clock never goes back. */
  const switchTo = (symbol: string) => {
    if (dayListId === null || opening !== null) return;
    if (api.player.status === "playing") api.togglePlay();
    setOpening(symbol);
    startDaySession(dayListId, symbol)
      .then((next) => router.replace(`/practice/replay?id=${next.id}`))
      .catch((error) => {
        api.notify("error", problemMessage(error, SWING_PLAY_COPY.switchError));
        setOpening(null);
      });
  };
  const exitTarget = shownPause
    ? pauseExit(shownPause, { sessionSymbol: spec.symbol, openSide: side, strip: view.strip, held: dayRows.map((row) => ({ symbol: row.symbol, side: row.side })) })
    : null;
  /** Exit on the toast: an exit mark at the revealed price, on this chart's name or (through its session) on another's. */
  const exitPaused = (target: PauseExit) => {
    if (target.here) {
      void api.mark(target.kind, {}).then((accepted) => accepted && answerPause());
      return;
    }
    if (dayListId === null) return;
    const built = exitMark(target.kind);
    if (!built.ok) return;
    setOpening(target.symbol);
    startDaySession(dayListId, target.symbol)
      .then(async (other) => {
        // Opening the name's session lifted it to the shared day clock (it cannot be marked while behind it): the exit follows.
        await sendMark(other.id, built.mark);
        router.replace(`/practice/replay?id=${other.id}`);
      })
      .catch((error) => {
        api.notify("error", problemMessage(error, PRACTICE_COPY.markError));
        setOpening(null);
      });
  };
  const holdsOpen = stripHoldCount(view.strip);
  const swingDay = swing && session.thread ? swingDayChip(session.thread, spec.day, hidden) : null;
  // The swing Daily view draws none of the intraday lines, so the settings show those groups switched off.
  const dailyView = swing && chartMode === "daily" && view.daily !== null;

  const dayLabel = masked ? PRACTICE_COPY.hiddenDay : formatEtDay(spec.day);
  const bottomShown = bottomOpen ?? band === "1440";
  const realized = practicePnl(session.journal, null);

  // The panel opens and closes only when she asks, so a mark never moves the chart (D-146). A panel left closed still names the
  // newest mark in its tab row, so a mark she just placed is visible without Expand (D-028).
  const newestMark = markRows(session.marks)[0] ?? null;

  // Click-to-order on the chart: only while she could use the ticket's buttons, and once there is a print to price against.
  const lastPrice = view.last?.price ?? null;
  const chartOrder = ended || behind || lastPrice === null
    ? undefined
    : { shares: ticket.shares, place: (chosen: "buy" | "sell", price: number) => submitTicket(chosen, chartOrderDraft(ticket, chosen, price, lastPrice)) };

  const controls = (
    <PracticeControls
      symbol={spec.symbol}
      side={side}
      openTrade={view.openTrade}
      ticket={ticket}
      onTicket={editTicket}
      ticketError={ticketError}
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
      disabled={ended || behind}
      swing={swing ? { tape: session.tape_feed === "off" ? "off" : "on", cash: freeCashText(session.thread?.free_cash_usd) } : undefined}
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

  const tapeOff = swing && session.tape_feed === "off";
  // The right rail is the order side of the workspace: the ticket (Practice) and the signals. The tape is the left rail's.
  const sections: RailSection[] = [
    { id: "practice", label: "Practice", node: controls },
    { id: "signals", label: "Signals", node: signalsRail },
  ];

  const quick = band === "1180" ? (
    <span className={styles.quick} role="group" aria-label="Practice buttons">
      <Button variant="up" size="md" disabled={ended || behind} onClick={() => order("buy")}>Buy</Button>
      <Button variant="down" size="md" disabled={ended || behind} onClick={() => order("sell")}>Sell</Button>
      <Button size="md" disabled={ended || behind || side === "flat"} onClick={() => order("close")}>Close position</Button>
    </span>
  ) : null;

  return (
    <div className={styles.workspace} data-drawer={band === "1180" && railOpen.length > 0 ? "open" : undefined} data-full={full ? "true" : undefined}>
      {!full && <PracticeTabs threadId={session.thread_id ?? session.thread?.id ?? null} active="order" mode={swing ? "swing" : "day"} back={dayListId === null} />}
      {/* A day thread's clock is the thread's, on the server, and its controls are on the Summary: none of that is on a chart (ADR-0018).
          A swing session and a standalone replay still carry their own clock bar. */}
      {!followed && (
        <ThreadClockBar
          label={dayListId !== null ? PRACTICE_COPY.threadTime : PRACTICE_COPY.replayTime}
          hint={dayListId !== null ? PRACTICE_COPY.threadTimeHint : PRACTICE_COPY.replayTimeHint}
          status={api.player.status}
          busy={api.player.busy}
          speed={api.player.speed}
          error={api.player.error}
          windowStart={session.window_start}
          windowEnd={session.window_end}
          focusEnd={etWallToUtcIso(etDayOf(session.window_start), spec.window.to)}
          clock={clock}
          marks={session.marks}
          signals={view.signals}
          onToggle={api.togglePlay}
          onStep={api.step}
          onSpeed={api.setSpeed}
          onJumpBy={api.jumpBy}
          onJumpToTime={api.jumpToTime}
          onNextSignal={api.nextSignal}
          onJumpEnd={api.jumpToEnd}
          swing={swing}
        />
      )}
      {followed && (
        // Read-only: the thread's time and whether it is running. Play or Pause, the speed and Skip day are on the Summary.
        <p className={styles.timeReadout} role="status" aria-live="off" data-testid="thread-time-readout" data-running={view.clockRunning ? "true" : "false"}>
          <span>{PRACTICE_COPY.threadTime}</span>
          <span data-testid="thread-clock-time">{formatEtClock(clock)}</span>
          <span>{PRACTICE_COPY.clockReplayedShort}</span>
          <span>{view.clockRunning ? practiceText("clockStateRunning", { speed: view.clockSpeed }) : atEnd ? PRACTICE_COPY.clockStateClosed : PRACTICE_COPY.clockStatePaused}</span>
          {session.thread_id !== null && <Link href={`/practice/thread?id=${session.thread_id}`} className={styles.link}>{view.clockRunning || atEnd ? PRACTICE_COPY.chartClockLinkControls : PRACTICE_COPY.chartClockLink}</Link>}
        </p>
      )}
      <ReplayHeader
        symbol={spec.symbol}
        dayLabel={swingDay ?? dayLabel}
        attempt={session.attempt}
        lastPrice={view.last?.price ?? null}
        vwap={vwap}
        priorClose={view.levels.prior_close ?? null}
        pnl={pnl}
        swing={swing && session.thread ? { money: swingMoneyLine(session.thread), tapeNote: tapeNote(session.tape_feed) } : undefined}
      />
      {session.thread && !swing && !full && <ThreadStrip thread={session.thread} />}
      <ReplayToast toast={api.toast} onDismiss={api.dismissToast} onHold={api.holdToast} onRelease={api.releaseToast} />
      {shownPause && (
        <StopPausedToast paused={shownPause} exit={exitTarget} busy={api.player.busy || opening !== null} onExit={() => exitTarget && exitPaused(exitTarget)} onKeep={answerPause} />
      )}
      {behind && view.dayClock && (
        <p className={styles.warning} role="status" data-testid="behind-clock">
          <span>{practiceText("replayBehind", { symbol: spec.symbol, clock: formatEtTimeZone(view.dayClock) })}</span>
          <button type="button" className={styles.linkButton} disabled={api.player.busy} onClick={api.catchUp}>{PRACTICE_COPY.replayCatchUp}</button>
        </p>
      )}
      <div className={styles.chartSlot} data-testid="chart-slot">
        <ReplayChart symbol={spec.symbol} view={view} bars={bars} series={series} hideDates={hidden} focus={focus} dimmed={Boolean(api.player.error)} swing={swing ? { mode: chartMode } : undefined} order={chartOrder} prefs={prefs} onTogglePref={(id: PrefId) => updatePrefs(togglePref(prefs, id))} />
      </div>
      <ChartToolbar
        symbol={spec.symbol}
        interval={view.interval}
        onInterval={api.setInterval}
        quick={quick}
        chartToggle={swing ? <ChartIntervalToggle mode={chartMode} onMode={pickMode} /> : undefined}
        view={
          <>
            <ChartSettings open={settingsOpen} onOpenChange={setSettingsOpen} prefs={prefs} onChange={updatePrefs} daily={dailyView} />
            <FullScreenButton full={full} onToggle={() => setFull((on) => !on)} />
          </>
        }
      />
      {/* A day-trade list's session has no foot: its day is ended from the Day list, which the tab strip above reaches. A standalone session and a swing day (whose Board cannot end a practiced day) keep the one End control. */}
      {(dayListId === null || swing) && (
        <EndPrompt
          tradeCount={trades}
          atEnd={atEnd}
          busy={api.player.busy || dayBusy}
          swing={swing && session.thread?.day_no != null ? { dayNo: session.thread.day_no, clock, holdsOpen } : undefined}
          ended={ended ? { swing, journalHref: `/practice/journal?id=${session.id}` } : null}
          onEnd={() => {
            if (dayListId === null) {
              void api.end().then((done) => done && router.push(`/practice/journal?id=${done.id}`));
              return;
            }
            // A swing day leaves its holds open overnight and goes back to its board, ended.
            if (api.player.status === "playing") api.togglePlay();
            setDayBusy(true);
            const ending: Promise<unknown> = whenReady(() => endAnyDay(dayListId));
            ending
              .then(() => router.push(`/practice/day?id=${dayListId}`))
              .catch(() => {
                api.notify("error", PRACTICE_COPY.swingEndError);
                setDayBusy(false);
              });
          }}
        />
      )}
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
          {swing && (
            <>
              <div className={styles.sessionSection}>
                <DayStrip rows={view.strip} current={spec.symbol} opening={opening} disabled={ended} onSwitch={switchTo} />
              </div>
              <SwingPlanChecklist
                items={swingPlanItems({
                  holdsOpen,
                  maxTrades: swingContext.plan?.maxTrades ?? null,
                  maxLossUsd: swingContext.plan?.maxLossUsd ?? null,
                  week: swingContext.week,
                })}
              />
            </>
          )}
          <IndicatorsPanel bars={indicatorBars.bars} interval={indicatorBars.interval} timeframe={indicatorBars.timeframe} />
          <section className={tapeOff ? styles.sessionSection : styles.tapeSection} aria-label="Tape" data-testid="tape-panel">
            <h2 className={styles.railTitle}>Tape</h2>
            {tapeOff ? (
              <>
                <p className={styles.muted}>{PRACTICE_COPY.swingTapeOff}</p>
                <p className={styles.footnote}>{PRACTICE_COPY.swingTapeOffFootnote}</p>
              </>
            ) : (
              <div className={styles.tapeSlot}>
                <TapePanel view={view} filterId={api.filterId} onFilter={api.setFilter} />
              </div>
            )}
          </section>
        </div>
      </LeftRailPortal>
      <RightRail sections={sections} label="Replay context" multi openIds={railOpen} onOpenIdsChange={setRailOpen} />
    </div>
  );
}
