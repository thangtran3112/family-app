"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { JumpMenu } from "@/components/practice/replay/JumpMenu";
import { SpeedChips } from "@/components/practice/replay/SpeedChips";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FactList } from "@/components/ui/FactList";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import { formatEtClock, formatEtTime } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { whenReady } from "@/lib/desk/patience";
import { endDay } from "@/lib/desk/replay";
import { useDayPortfolio } from "@/components/practice/replay/Portfolio";
import { endDayExitText, portfolioRows } from "@/lib/replay/dayView";
import { problemMessage } from "@/lib/replay/setup";
import { etDayOf, etWallToUtcIso } from "@/lib/replay/time";
import { clockControls, clockProgress, clockStateText, focusProgress, skippedText, type SkipDay } from "@/lib/replay/threadClock";
import { formatBalance, formatDayResult } from "@/lib/replay/threadView";
import type { ThreadClockApi } from "@/lib/replay/useThreadClock";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/**
 * The day thread's clock and its controls, on the Summary and nowhere else (ADR-0018): Play or Pause, Step, speed, Jump, Skip day and End day for
 * the whole thread. Both ways of finishing the day are here (the Day list has none): Skip day runs to the close and opens the next day; End day
 * stops at the clock, exits what is open at that price and opens the day's review. The time is the server's. It keeps running when this page is closed or she signs out; this panel only asks
 * for changes and shows the answer (polled every two seconds). Only Pause, the speed and Skip day change how time moves: the market's close rolls
 * the day over by itself, and the plan's practice window is a mark on the track, not a stop. The simulated account beside it is priced at that clock.
 */
export function ThreadClockPanel({ api, onSkipped }: { api: ThreadClockApi; onSkipped: (result: SkipDay) => void }) {
  const { clock, shown } = api;
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLButtonElement>(null);
  // The End day confirm names the open trades it exits: the day list is read only while the question is open.
  const openDayId = clock?.day_list_id ?? null;
  const portfolio = useDayPortfolio(openDayId, api.revision, confirmingEnd && openDayId !== null);

  if (clock === null) {
    return (
      <section className={styles.panel} aria-label={PRACTICE_COPY.clockTitle} data-testid="thread-clock">
        <h2 className={styles.panelTitle}>{PRACTICE_COPY.clockTitle}</h2>
        <p className={o.placeLine} role="status">{api.error ?? (api.loading ? PRACTICE_COPY.loadingReplay : "")}</p>
      </section>
    );
  }
  const can = clockControls(clock);
  const running = clock.state === "running";
  const focus = focusProgress(clock);
  const account = clock.account;
  const exits = portfolio.data === null ? null : endDayExitText(portfolioRows(portfolio.data), clock.clock);
  const busy = api.busy || ending;
  const speed = clock.speed;
  const dayListId = clock.day_list_id;

  async function skip() {
    const result = await api.skipDay();
    setConfirming(false);
    if (result !== null) {
      setNote(skippedText(result));
      onSkipped(result);
    }
  }

  // Ending is safe to ask twice (the server answers an ended day the same), so a gateway cut waits and asks again. On success the review is the next screen.
  async function end() {
    if (dayListId === null) return;
    setEnding(true);
    setEndError(null);
    try {
      await whenReady(() => endDay(dayListId), { onWaiting: () => setNote(PRACTICE_COPY.dayEndStillWorking) });
      router.push(`/practice/day?id=${dayListId}`);
    } catch (failure) {
      setEndError(problemMessage(failure, PRACTICE_COPY.dayEndError));
      setNote(null);
      setEnding(false);
      setConfirmingEnd(false);
    }
  }

  return (
    <section className={styles.panel} aria-label={PRACTICE_COPY.clockTitle} data-testid="thread-clock" data-state={clock.state}>
      <div className={o.sectionHead}>
        <h2 className={styles.panelTitle}>{PRACTICE_COPY.clockTitle}</h2>
        {clock.state !== "no_day" && <Badge tone={running ? "up" : "neutral"} data-testid="thread-clock-state">{clockStateText(clock)}</Badge>}
      </div>

      {clock.state === "no_day" && <p className={o.placeLine}>{PRACTICE_COPY.clockNoDay}</p>}
      {clock.state === "listed" && <p className={o.placeLine}>{PRACTICE_COPY.clockNotStarted}</p>}

      {can.started && (
        <>
          <p className={o.clockTime}>
            <span data-testid="thread-clock-time">{formatEtClock(shown)}</span>
          </p>
          <div className={o.clockTrack} role="progressbar" aria-label="Day progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clockProgress(clock, shown) * 100)}>
            <div className={o.clockFill} style={{ width: `${clockProgress(clock, shown) * 100}%` }} />
            {focus !== null && <span className={o.clockFocus} style={{ left: `${focus * 100}%` }} title={clock.focus_end === null ? undefined : practiceText("clockFocusMark", { time: formatEtTime(clock.focus_end) })} data-testid="thread-clock-focus" />}
          </div>
          {clock.focus_end !== null && <p className={styles.hint}>{practiceText("clockFocusMark", { time: formatEtTime(clock.focus_end) })}</p>}
        </>
      )}

      {clock.state !== "no_day" && (
        <div className={o.clockControls} role="group" aria-label="Clock controls">
          {can.started && (
            <>
              <Button size="touch" variant="primary" disabled={!can.play || busy} aria-label={running ? PRACTICE_COPY.clockPause : PRACTICE_COPY.clockPlay} onClick={() => void (running ? api.pause() : api.play())}>
                {running ? PRACTICE_COPY.clockPause : PRACTICE_COPY.clockPlay}
              </Button>
              <Button size="touch" disabled={!can.jump || busy} title="One bar forward" onClick={() => void api.step()}>{PRACTICE_COPY.clockStep}</Button>
              <SpeedChips speed={speed} onSpeed={(next) => void api.setSpeed(next)} />
              <JumpMenu
                revealedThrough={shown ?? clock.clock ?? ""}
                windowEnd={clock.window_end ?? ""}
                disabled={!can.jump || busy}
                onJumpBy={(minutes) => void api.jumpBy(minutes)}
                onJumpToTime={(hhmm) => {
                  const to = clock.clock === null ? null : etWallToUtcIso(etDayOf(clock.clock), hhmm);
                  if (to !== null) void api.jumpTo(to);
                }}
                onNextSignal={() => void api.nextSignal()}
                onJumpEnd={() => clock.window_end !== null && void api.jumpTo(clock.window_end)}
              />
            </>
          )}
          <Button ref={skipRef} size="touch" disabled={!can.skip || busy || confirming || confirmingEnd} onClick={() => setConfirming(true)}>{PRACTICE_COPY.clockSkipDay}</Button>
          <Button ref={endRef} size="touch" disabled={!can.skip || busy || confirming || confirmingEnd} aria-expanded={confirmingEnd} onClick={() => setConfirmingEnd(true)}>{PRACTICE_COPY.clockEndDay}</Button>
        </div>
      )}

      {confirming && (
        <InlineConfirm
          label="Confirm skipping the day"
          prompt={PRACTICE_COPY.clockSkipAsk}
          confirmLabel={PRACTICE_COPY.clockSkipConfirm}
          cancelLabel={PRACTICE_COPY.clockSkipCancel}
          layout="block"
          busy={busy}
          returnFocus={skipRef}
          onConfirm={() => void skip()}
          onCancel={() => setConfirming(false)}
        />
      )}

      {confirmingEnd && (
        <InlineConfirm
          label="Confirm ending the day"
          prompt={
            <>
              <span>{practiceText("clockEndAsk", { clock: formatEtClock(shown) })}</span>
              {exits && <span>{exits}</span>}
            </>
          }
          confirmLabel={PRACTICE_COPY.dayEndYes}
          cancelLabel={PRACTICE_COPY.clockSkipCancel}
          layout="block"
          busy={ending}
          returnFocus={endRef}
          onConfirm={() => void end()}
          onCancel={() => setConfirmingEnd(false)}
        />
      )}

      {api.rolled && <p className={o.placeLine} role="status" data-testid="thread-clock-rolled">{api.rolled}</p>}
      {note && <p className={o.placeLine} role="status">{note}</p>}
      {api.error && <p className={o.placeLine} role="alert">{api.error}</p>}
      {endError && <p className={o.placeLine} role="alert">{endError}</p>}

      {account && can.started && (
        <div data-testid="thread-clock-account">
          <div className={o.sectionHead}>
            <h3 className={o.clockSub}>{PRACTICE_COPY.clockAccountEquity}</h3>
            <SimulatedBadge />
          </div>
          <FactList
            columns={2}
            facts={[
              { id: "balance", label: PRACTICE_COPY.clockAccountBalance, value: formatBalance(account.balance) },
              { id: "open", label: PRACTICE_COPY.clockAccountOpen, value: formatDayResult(account.open_pnl_usd), tone: account.open_pnl_usd > 0 ? "up" : account.open_pnl_usd < 0 ? "down" : "neutral" },
              { id: "equity", label: PRACTICE_COPY.clockAccountEquity, value: <span data-testid="thread-clock-equity">{formatBalance(account.equity_usd)}</span> },
            ]}
          />
          <p className={styles.hint}>{PRACTICE_COPY.clockAccountHint}</p>
        </div>
      )}
      <p className={styles.hint}>{PRACTICE_COPY.clockHint}</p>
    </section>
  );
}
