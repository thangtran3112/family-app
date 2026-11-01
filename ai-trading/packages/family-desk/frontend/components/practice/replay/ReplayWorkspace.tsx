"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartIntervalToggle } from "@/components/practice/swing/ChartIntervalToggle";
import { DayStrip } from "@/components/practice/swing/DayStrip";
import { StopPausedToast } from "@/components/practice/swing/StopPausedToast";
import { SwingPlanChecklist } from "@/components/practice/swing/SwingPlanChecklist";
import { useSwingContext } from "@/components/practice/swing/useSwingContext";
import { PracticeTabs } from "@/components/practice/hub/PracticeTabs";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { ThreadStrip } from "@/components/practice/thread/ThreadStrip";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { LeftRailPortal } from "@/components/shell/desktop/LeftRailPortal";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail, type RailSection } from "@/components/shell/desktop/RightRail";
import { Button } from "@/components/ui/Button";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { currentValue } from "@/lib/chart-data";
import { threadClock } from "@/lib/replay/clock";
import { formatEtDay, formatEtTimeZone } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { openRailTab } from "@/lib/desk/rail";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { buildChartSeries } from "@/lib/desk/workspace";
import { endDay, placeMark as sendMark, startDaySession } from "@/lib/desk/replay";
import { briefLine } from "@/lib/replay/threadView";
import { endDayExitText, portfolioRows } from "@/lib/replay/dayView";
import { readChartPrefs, togglePref, writeChartPrefs, type ChartPrefs, type PrefId } from "@/lib/replay/chartPrefs";
import { actionForKey, layerToClose, markActionFor, type ReplayAction } from "@/lib/replay/keys";
import { exitMark } from "@/lib/replay/markInput";
import { entrySince, levelRows, markRows, openSide } from "@/lib/replay/marks";
import { planChecklist, planNote, practicePnl, sessionFacts, tradeCount } from "@/lib/replay/planView";
import {
  SWING_PLAY_COPY,
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
import { buildTicket, initialTicket, type TicketDraft, type TicketField } from "@/lib/replay/ticket";
import { whenReady } from "@/lib/desk/patience";
import { endAnyDay } from "@/lib/replay/swingApi";
import { useReplaySession, type ReplaySessionApi } from "@/lib/replay/useReplaySession";
import { chartBars, type ReplayView } from "@/lib/replay/feedState";
import { ArmedStrategiesList } from "./ArmedStrategiesList";
import { ChartSettings, FullScreenButton } from "./ChartSettings";
import { ChartToolbar } from "./ChartToolbar";
import { PortfolioPanel, useDayPortfolio } from "./Portfolio";
import { EndPrompt } from "./EndPrompt";
import { LevelsList } from "./LevelsList";
import { MarksList } from "./MarksList";
import { PlanChecklist } from "./PlanChecklist";
import { PracticeControls, type Composer } from "./PracticeControls";
import { REPLAY_INDICATORS, ReplayChart } from "./ReplayChart";
import { ReplayHeader } from "./ReplayHeader";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SignalsRail, signalKey } from "./SignalsRail";
import { TapePanel } from "./TapePanel";
import { ThreadClockBar } from "./ThreadClockBar";
import styles from "./replay.module.css";
import { FactList } from "@/components/ui/FactList";

/** `/practice/replay?id=`: the chart, the tape, the controls and the keyboard map (02o §a3). Reads the URL, so the page wraps it in Suspense. */
export function ReplayWorkspace() {
  const params = useSearchParams();
  const raw = params.get("id");
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;

  if (id === null) {
    return (
      <div className={styles.page}>
        <EmptyBlock title="No practice session selected">
          <Link href="/practice" className={styles.link}>Open Practice</Link>
        </EmptyBlock>
      </div>
    );
  }
  // A new id (a swing day strip click opens another name's session) is a fresh workspace: nothing of the old one carries over.
  return <ReplayById key={id} id={id} />;
}

function ReplayById({ id }: { id: number }) {
  const api = useReplaySession(id);
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
  if (api.paused !== null && pause?.paused !== api.paused) setPause({ paused: api.paused, at: view.revealedThrough });
  const shownPause = pause !== null && pause.at === view.revealedThrough && session.status !== "ended" ? pause.paused : null;
  const answerPause = () => {
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
  const [helpOpen, setHelpOpen] = useState(false);
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
  const [focus, setFocus] = useState<{ time: string; at: number } | null>(null);
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);
  const [dayBusy, setDayBusy] = useState(false);
  const dayListId = session.day_list_id;
  const side = openSide(view.openTrade);
  const pnl = practicePnl(session.journal, view.openTrade);
  const trades = tradeCount(session.journal, view.openTrade);
  const atEnd = api.player.status === "at_end" || ended;
  const behind = view.behindClock && !ended;
  // The thread's one time: the day clock for a name on a day list (a name left behind it shows the thread's time, not its own old playhead).
  const clock = threadClock(view.revealedThrough, view.dayClock);
  // A day's portfolio: every name she holds, read once here so the rail, the stop-pause toast and End day agree on it.
  // The list prices every open trade at the day clock, so it is read again after a mark and whenever the clock settles (a step, a
  // jump, a stop pause), not on every bar of a running replay: each read prices up to five names.
  // While paused the clock follows the playhead; while playing it stays at the playhead it had when the replay last paused. It is
  // adjusted during render (as `pause` above is), so a paused reveal re-renders once before commit, not again after an effect.
  const playing = api.player.status === "playing";
  const [clockSeen, setClockSeen] = useState(view.revealedThrough);
  if (!playing && clockSeen !== view.revealedThrough) setClockSeen(view.revealedThrough);
  const dayList = useDayPortfolio(swing ? null : dayListId, session.marks.length * 2 + (behind ? 1 : 0) + Math.floor(Date.parse(clockSeen) / 1000));
  const dayRows = dayList.data === null ? [] : portfolioRows(dayList.data, { symbol: spec.symbol, playhead: view.revealedThrough, openTrade: view.openTrade });

  // An ended day session has been scored and its review shows the date, so the replay stops hiding it (D-100). A swing thread keeps its dates hidden across the block.
  const masked = hidden && !dateShown && !(ended && !swing);
  useReportPracticeChrome({ day: spec.day, hidden: masked, playhead: clock, status: replayStatusLine(session.tape_feed, clock), onShowDate: masked ? () => setDateShown(true) : null });

  // The chart's bars and series are built once: the chart draws them and the header reads VWAP from the same series.
  const bars = useMemo(() => chartBars(view), [view]);
  const series = useMemo(() => buildChartSeries(bars, REPLAY_INDICATORS, view.interval), [bars, view.interval]);
  const vwap = currentValue(series.overlays.find((overlay) => overlay.id === "vwap")?.values ?? []);

  // At the 1180 band the right rail is a drawer: the tape opens when play starts, the controls open for T and N.
  const toggle = () => {
    if (api.player.status === "paused" && band === "1180" && railOpen.length === 0) setRailOpen(["tape"]);
    api.togglePlay();
  };
  const openComposer = (next: Composer) => {
    setComposer(next);
    if (next && band === "1180") setRailOpen((open) => openRailTab(open, "practice"));
  };

  /** Buy or Sell as the ticket stands: a market entry, or a limit, stop or stop-limit order that waits on the tape. */
  const submitTicket = (chosen: "buy" | "sell") => {
    const built = buildTicket({ ...ticket, side: chosen });
    if (!built.ok) {
      setTicket((current) => ({ ...current, side: chosen }));
      setTicketError({ field: built.field, message: built.message });
      if (band === "1180") setRailOpen((open) => openRailTab(open, "practice")); // the message sits at the field
      return;
    }
    setTicketError(null);
    void api.ticket(built.action).then((accepted) => {
      if (accepted) setTicket((current) => ({ ...current, side: chosen, limitPrice: "", stopPrice: "" })); // the quantity stays as typed
    });
  };
  const placeMark = (kind: Parameters<ReplaySessionApi["mark"]>[0]) => {
    if (kind === "long_entry" || kind === "short_entry") {
      submitTicket(kind === "long_entry" ? "buy" : "sell");
      return;
    }
    void api.mark(kind, {}).then((accepted) => {
      // Closing the name whose stop paused play answers the toast.
      if (accepted && shownPause?.symbol === spec.symbol) answerPause();
    });
  };
  const byLetter = (letter: "b" | "s" | "x") => perform(markActionFor(letter, side));

  const perform = (action: ReplayAction) => {
    switch (action.type) {
      case "toggle_play": toggle(); break;
      case "step": api.step(); break;
      case "next_signal": api.nextSignal(); break;
      case "speed": api.setSpeed(action.speed); break;
      case "mark": placeMark(action.kind); break;
      case "stop_note": openComposer("stop"); break;
      case "note": openComposer("note"); break;
      case "undo": api.undo(); break;
      case "help": setHelpOpen((open) => !open); break;
      case "toggle_full": setFull((on) => !on); break;
      case "chart_settings": setSettingsOpen((open) => !open); break;
      case "close":
        switch (layerToClose({ settings: settingsOpen, help: helpOpen, composer: composer !== null, full })) {
          case "settings": setSettingsOpen(false); break;
          case "help": setHelpOpen(false); break;
          case "composer": setComposer(null); break;
          case "full": setFull(false); break;
        }
        break;
      case "blocked": api.notify("info", action.message); break;
    }
  };
  const performRef = useRef(perform);
  useEffect(() => {
    performRef.current = perform;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented) return;
      const element = event.target instanceof HTMLElement ? event.target : null;
      const action = actionForKey(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          target: element ? { tagName: element.tagName, isContentEditable: element.isContentEditable, type: (element as HTMLInputElement).type, role: element.getAttribute("role") } : null,
        },
        side,
        helpOpen,
      );
      if (!action) return;
      event.preventDefault();
      performRef.current(action);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [side, helpOpen]);

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

  const armed = session.armed.map((item) => ({
    key: `${item.source}:${item.id}`,
    name: item.name,
    bias: item.bias,
    fires: view.signals.filter((signal) => signal.source === item.source && signal.id === item.id).length,
  }));
  const dayLabel = masked ? PRACTICE_COPY.hiddenDay : formatEtDay(spec.day);
  const bottomShown = bottomOpen ?? band === "1440";
  const realized = practicePnl(session.journal, null);

  // A mark just placed shows in the Marks list without a click on Expand, unless she collapsed the panel herself (D-028).
  const markCount = session.marks.length;
  const seenMarks = useRef(markCount);
  useEffect(() => {
    if (markCount > seenMarks.current) {
      setBottomTab("marks");
      setBottomOpen((open) => open ?? true);
    }
    seenMarks.current = markCount;
  }, [markCount]);

  const controls = (
    <PracticeControls
      symbol={spec.symbol}
      side={side}
      openTrade={view.openTrade}
      lastPrice={view.last?.price ?? null}
      ticket={ticket}
      onTicket={editTicket}
      ticketError={ticketError}
      onSubmit={(chosen) => byLetter(chosen === "buy" ? "b" : "s")}
      orders={session.orders}
      onCancelOrder={api.cancelOrder}
      since={entrySince(session.marks, view.openTrade)}
      realized={realized}
      pnl={pnl}
      composer={composer}
      onComposer={openComposer}
      onExit={() => byLetter("x")}
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

  const portfolio =
    dayListId !== null && !swing ? (
      <PortfolioPanel
        dayListId={dayListId}
        query={dayList}
        from={{ symbol: spec.symbol, playhead: view.revealedThrough, openTrade: view.openTrade }}
        onExitHere={() => byLetter("x")}
        onExited={(symbol) => {
          if (shownPause?.symbol === symbol) answerPause();
        }}
      />
    ) : null;

  const sections: RailSection[] = [
    {
      id: "tape",
      label: "Tape",
      node: swing && session.tape_feed === "off" ? (
        <div className={styles.controls}>
          <p className={styles.muted}>{PRACTICE_COPY.swingTapeOff}</p>
          <p className={styles.footnote}>{PRACTICE_COPY.swingTapeOffFootnote}</p>
        </div>
      ) : (
        <div className={styles.tapeSlot}>
          <TapePanel view={view} filterId={api.filterId} onFilter={api.setFilter} />
        </div>
      ),
    },
    { id: "practice", label: "Practice", node: controls },
    ...(band === "1180" ? [{ id: "signals", label: "Signals", node: signalsRail }] : []),
    // At 1440 the day's portfolio sits in the left rail; at 1180 that rail is a strip, so it opens from the right drawer.
    ...(band === "1180" && portfolio !== null ? [{ id: "portfolio", label: PRACTICE_COPY.dayPortfolio, node: portfolio }] : []),
  ];
  const fires = armed.reduce((sum, item) => sum + item.fires, 0);

  const quick = band === "1180" ? (
    <span className={styles.quick} role="group" aria-label="Practice buttons">
      <Button variant="up" size="md" disabled={ended || behind} aria-keyshortcuts="B" onClick={() => byLetter("b")}>Buy</Button>
      <Button variant="down" size="md" disabled={ended || behind} aria-keyshortcuts="S" onClick={() => byLetter("s")}>Sell</Button>
      <Button size="md" disabled={ended || behind || side === "flat"} aria-keyshortcuts="X" onClick={() => byLetter("x")}>Close position</Button>
    </span>
  ) : null;

  return (
    <div className={styles.workspace} data-drawer={band === "1180" && railOpen.length > 0 ? "open" : undefined} data-full={full ? "true" : undefined}>
      {!full && <PracticeTabs threadId={session.thread_id ?? session.thread?.id ?? null} active="trade" mode={swing ? "swing" : "day"} />}
      {/* The thread's clock sits above every name's header and chart: one time for all the tickers of the day, never under one chart. */}
      <ThreadClockBar
        label={dayListId !== null ? PRACTICE_COPY.threadTime : PRACTICE_COPY.replayTime}
        hint={dayListId !== null ? PRACTICE_COPY.threadTimeHint : PRACTICE_COPY.replayTimeHint}
        status={api.player.status}
        busy={api.player.busy}
        speed={api.player.speed}
        error={api.player.error}
        windowStart={session.window_start}
        windowEnd={session.window_end}
        clock={clock}
        marks={session.marks}
        signals={view.signals}
        onToggle={toggle}
        onStep={api.step}
        onSpeed={api.setSpeed}
        onJumpBy={api.jumpBy}
        onJumpToTime={api.jumpToTime}
        onNextSignal={api.nextSignal}
        onJumpEnd={api.jumpToEnd}
        swing={swing}
      />
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
      {api.toast && (
        <p className={styles.toast} data-tone={api.toast.tone} role={api.toast.tone === "error" ? "alert" : "status"}>
          <span>{api.toast.text}</span>
          <button type="button" className={styles.linkButton} onClick={api.dismissToast} aria-label="Dismiss message">×</button>
        </p>
      )}
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
        <ReplayChart symbol={spec.symbol} view={view} bars={bars} series={series} marks={session.marks} hideDates={hidden} focus={focus} dimmed={Boolean(api.player.error)} swing={swing ? { mode: chartMode } : undefined} prefs={prefs} onTogglePref={(id: PrefId) => updatePrefs(togglePref(prefs, id))} />
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
      <EndPrompt
        tradeCount={trades}
        atEnd={atEnd}
        busy={api.player.busy || dayBusy}
        day={dayListId !== null}
        exits={dayListId !== null && !swing ? endDayExitText(dayRows) : null}
        swing={swing && session.thread?.day_no != null ? { dayNo: session.thread.day_no, clock, holdsOpen } : undefined}
        backHref={dayListId !== null && !full ? `/practice/day?id=${dayListId}` : null}
        ended={ended ? { swing, journalHref: `/practice/journal?id=${session.id}` } : null}
        onEnd={() => {
          if (dayListId === null) {
            void api.end().then((done) => done && router.push(`/practice/journal?id=${done.id}`));
            return;
          }
          // A daily-list session ends with its day, which also unseals the list review. A swing day leaves its holds open
          // overnight and goes back to its board, ended.
          if (swing && api.player.status === "playing") api.togglePlay();
          setDayBusy(true);
          const ending: Promise<unknown> = whenReady(() => (swing ? endAnyDay(dayListId) : endDay(dayListId)));
          ending
            .then(() => router.push(`/practice/day?id=${dayListId}`))
            .catch(() => {
              api.notify("error", swing ? PRACTICE_COPY.swingEndError : PRACTICE_COPY.markError);
              setDayBusy(false);
            });
        }}
      />
      <section className={styles.bottom} aria-label="Marks and levels" data-open={bottomShown ? "true" : "false"}>
        <div className={styles.bottomTabs} role="tablist" aria-label="Bottom panel">
          {(["marks", "levels"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              className={styles.tab}
              aria-selected={bottomTab === tab}
              onClick={() => {
                setBottomTab(tab);
                setBottomOpen(true);
              }}
            >
              {tab === "marks" ? "Marks" : "Levels"}
            </button>
          ))}
          <button type="button" className={styles.linkButton} aria-expanded={bottomShown} onClick={() => setBottomOpen(!bottomShown)}>{bottomShown ? "Collapse" : "Expand"}</button>
        </div>
        {bottomShown && (
          <div className={styles.bottomBody} role="tabpanel">
            {bottomTab === "marks" ? <MarksList rows={markRows(session.marks)} /> : <LevelsList rows={levelRows(view.levels)} />}
          </div>
        )}
      </section>
      {helpOpen && <ShortcutsOverlay onClose={() => setHelpOpen(false)} />}
      <LeftRailPortal>
        <div className={styles.session}>
          {swing ? (
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
          ) : (
            <>
              <section className={styles.sessionSection} aria-label="Session">
                <h2 className={styles.railTitle}>Session</h2>
                <FactList facts={sessionFacts(spec, session.attempt, session.tape_feed)} />
              </section>
              <section className={styles.sessionSection} aria-label={session.thread ? PRACTICE_COPY.threadPlanTitle : "Plan"}>
                {session.thread ? (
                  <>
                    <div className={styles.railHead}>
                      <h2 className={styles.railTitle}>{PRACTICE_COPY.threadPlanTitle}</h2>
                      <SimulatedBadge />
                    </div>
                    <p className={styles.threadBalance}>{briefLine(session.thread)}</p>
                  </>
                ) : (
                  <h2 className={styles.railTitle}>Plan</h2>
                )}
                <PlanChecklist
                  items={planChecklist(spec.plan, session.journal, view.openTrade)}
                  shares={spec.shares}
                  note={planNote(spec.plan)}
                />
              </section>
              {band === "1440" && portfolio && (
                <section className={styles.sessionSection} aria-label={PRACTICE_COPY.dayPortfolio}>
                  <h2 className={styles.railTitle}>{PRACTICE_COPY.dayPortfolio}</h2>
                  {portfolio}
                </section>
              )}
            </>
          )}
          <section className={styles.sessionSection} aria-label="Armed strategies">
            <div className={styles.railHead}>
              <h2 className={styles.railTitle}>{`Armed strategies · ${armed.length}`}</h2>
              <span className={styles.railHint}>{fires === 1 ? "1 fire so far" : `${fires} fires so far`}</span>
            </div>
            <ArmedStrategiesList armed={armed} />
          </section>
          {band === "1440" && (
            <section className={styles.sessionSection} aria-label="Signals">
              <h2 className={styles.railTitle}>Signals</h2>
              {signalsRail}
            </section>
          )}
        </div>
      </LeftRailPortal>
      <RightRail sections={sections} label="Replay context" multi openIds={railOpen} onOpenIdsChange={setRailOpen} />
    </div>
  );
}
