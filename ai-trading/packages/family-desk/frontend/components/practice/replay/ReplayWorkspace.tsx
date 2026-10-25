"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LeftRailPortal } from "@/components/shell/desktop/LeftRailPortal";
import { useReportPracticeChrome } from "@/components/shell/desktop/PracticeChrome";
import { RightRail, type RailSection } from "@/components/shell/desktop/RightRail";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { formatEtDay } from "@/lib/desk/format";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { endDay } from "@/lib/desk/replay";
import { sessionOverText } from "@/lib/replay/journalView";
import { actionForKey, markActionFor, type ReplayAction } from "@/lib/replay/keys";
import type { MarkDraft } from "@/lib/replay/markInput";
import { levelRows, markRows, openSide } from "@/lib/replay/marks";
import { maxLossReached, planChecklist, practicePnl, tradeCount } from "@/lib/replay/planView";
import type { ReplaySession } from "@/lib/replay/schemas";
import { useReplaySession, type ReplaySessionApi } from "@/lib/replay/useReplaySession";
import type { ReplayView } from "@/lib/replay/feedState";
import { ArmedStrategiesList } from "./ArmedStrategiesList";
import { EndPrompt } from "./EndPrompt";
import { LevelsList } from "./LevelsList";
import { MarksList } from "./MarksList";
import { PlanChecklist } from "./PlanChecklist";
import { PracticeControls, type Composer } from "./PracticeControls";
import { ReplayChart } from "./ReplayChart";
import { ReplayHeader } from "./ReplayHeader";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SignalsRail, signalKey } from "./SignalsRail";
import { TapePanel } from "./TapePanel";
import { TransportBar } from "./TransportBar";
import styles from "./replay.module.css";

/** `/practice/replay?id=`: the chart, the tape, the controls and the keyboard map (02o §a3). Reads the URL, so the page wraps it in Suspense. */
export function ReplayWorkspace() {
  const params = useSearchParams();
  const raw = params.get("id");
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const api = useReplaySession(id);

  if (id === null) {
    return (
      <div className={styles.page}>
        <EmptyBlock title="No practice session selected">
          <Link href="/practice" className={styles.link}>Open Practice</Link>
        </EmptyBlock>
      </div>
    );
  }
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
  const [draft, setDraft] = useState<MarkDraft>({ shares: String(spec.shares), stopPrice: "" });
  const [composer, setComposer] = useState<Composer>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [railOpen, setRailOpen] = useState<string | null>(null);
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

  useReportPracticeChrome({ day: spec.day, hidden, playhead: view.revealedThrough });

  // At the 1180 band the right rail is a drawer: the tape opens when play starts, the controls open for T and N.
  const toggle = () => {
    if (api.player.status === "paused" && band === "1180" && railOpen === null) setRailOpen("tape");
    api.togglePlay();
  };
  const openComposer = (next: Composer) => {
    setComposer(next);
    if (next && band === "1180") setRailOpen("practice");
  };

  const placeMark = (kind: Parameters<ReplaySessionApi["mark"]>[0]) => {
    void api.mark(kind, draft).then((accepted) => {
      if (accepted && (kind === "long_entry" || kind === "short_entry")) setDraft((current) => ({ ...current, stopPrice: "" }));
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
      case "close":
        if (helpOpen) setHelpOpen(false);
        else if (composer) setComposer(null);
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

  const armed = session.armed.map((item) => ({
    key: `${item.source}:${item.id}`,
    name: item.name,
    bias: item.bias,
    fires: view.signals.filter((signal) => signal.source === item.source && signal.id === item.id).length,
  }));
  const dayLabel = hidden ? PRACTICE_COPY.hiddenDay : formatEtDay(spec.day);
  const lossHit = maxLossReached(pnl, spec.plan);
  const stopHint = spec.plan.stopRequired === "yes" && (draft.stopPrice ?? "").trim() === "";
  const bottomShown = bottomOpen ?? band === "1440";

  const controls = (
    <PracticeControls
      side={side}
      openTrade={view.openTrade}
      lastPrice={view.last?.price ?? null}
      draft={draft}
      onDraft={setDraft}
      stopHint={stopHint}
      composer={composer}
      onComposer={openComposer}
      onLong={() => byLetter("b")}
      onShort={() => byLetter("s")}
      onExit={() => byLetter("x")}
      onStop={api.stopNote}
      onNote={api.note}
      disabled={ended}
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

  const sections: RailSection[] = [
    {
      id: "tape",
      label: "Tape",
      node: (
        <div className={styles.tapeSlot}>
          <TapePanel view={view} filterId={api.filterId} onFilter={api.setFilter} />
        </div>
      ),
    },
    { id: "practice", label: "Practice", node: controls },
    ...(band === "1180" ? [{ id: "signals", label: "Signals", node: signalsRail }] : []),
  ];

  const quick = band === "1180" ? (
    <span className={styles.quick} role="group" aria-label="Practice buttons">
      <button type="button" className={`${styles.button} ${styles.long}`} disabled={ended} title="Practice long (B)" onClick={() => byLetter("b")}>Long</button>
      <button type="button" className={`${styles.button} ${styles.short}`} disabled={ended} title="Practice short (S)" onClick={() => byLetter("s")}>Short</button>
      <button type="button" className={styles.button} disabled={ended || side === "flat"} title="Exit (X)" onClick={() => byLetter("x")}>Exit</button>
    </span>
  ) : null;

  return (
    <div className={styles.workspace} data-drawer={band === "1180" && railOpen ? "open" : undefined}>
      <ReplayHeader
        symbol={spec.symbol}
        dayLabel={dayLabel}
        attempt={session.attempt}
        playhead={view.revealedThrough}
        lastPrice={view.last?.price ?? null}
        pnl={pnl}
      />
      {api.toast && (
        <p className={styles.toast} data-tone={api.toast.tone} role={api.toast.tone === "error" ? "alert" : "status"}>
          <span>{api.toast.text}</span>
          <button type="button" className={styles.linkButton} onClick={api.dismissToast} aria-label="Dismiss message">×</button>
        </p>
      )}
      {lossHit && <p className={styles.warning} role="status">{PRACTICE_COPY.maxLoss}</p>}
      <div className={styles.chartSlot}>
        <ReplayChart symbol={spec.symbol} view={view} marks={session.marks} hideDates={hidden} focus={focus} dimmed={Boolean(api.player.error)} />
      </div>
      <TransportBar
        status={api.player.status}
        speed={api.player.speed}
        error={api.player.error}
        windowStart={session.window_start}
        windowEnd={session.window_end}
        revealedThrough={view.revealedThrough}
        marks={session.marks}
        signals={view.signals}
        interval={view.interval}
        onInterval={api.setInterval}
        onToggle={toggle}
        onStep={api.step}
        onSpeed={api.setSpeed}
        onJumpBy={api.jumpBy}
        onJumpToTime={api.jumpToTime}
        onNextSignal={api.nextSignal}
        onJumpEnd={api.jumpToEnd}
        quick={quick}
      />
      {dayListId !== null && (
        <p className={styles.endLine}>
          <Link href={`/practice/day?id=${dayListId}`} className={styles.link}>{PRACTICE_COPY.backToList}</Link>
        </p>
      )}
      {ended ? (
        <p className={styles.endLine}>
          {sessionOverText(trades)} · <Link href={`/practice/journal?id=${session.id}`} className={styles.link}>Open the journal</Link>
        </p>
      ) : (
        <EndPrompt
          tradeCount={trades}
          atEnd={atEnd}
          busy={api.player.busy || dayBusy}
          day={dayListId !== null}
          onEnd={() => {
            if (dayListId === null) {
              void api.end().then((done) => done && router.push(`/practice/journal?id=${done.id}`));
              return;
            }
            // A daily-list session ends with its day, which also unseals the list review.
            setDayBusy(true);
            endDay(dayListId)
              .then(() => router.push(`/practice/day?id=${dayListId}`))
              .catch(() => {
                api.notify("error", PRACTICE_COPY.markError);
                setDayBusy(false);
              });
          }}
        />
      )}
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
          <section className={styles.sessionSection} aria-label="Plan">
            <h2 className={styles.railTitle}>Plan</h2>
            <PlanChecklist items={planChecklist(spec.plan, session.journal, view.openTrade)} shares={spec.shares} />
          </section>
          <section className={styles.sessionSection} aria-label="Armed strategies">
            <h2 className={styles.railTitle}>Armed strategies</h2>
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
      <RightRail sections={sections} label="Replay context" openId={band === "1180" ? railOpen : undefined} onOpenChange={band === "1180" ? setRailOpen : undefined} />
    </div>
  );
}
