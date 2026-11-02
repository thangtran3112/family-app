"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { SpeedChips } from "@/components/practice/replay/SpeedChips";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FactList } from "@/components/ui/FactList";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { formatEtDateClock, formatEtTime } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { whenReady } from "@/lib/desk/patience";
import { endDay } from "@/lib/desk/replay";
import { useDayPortfolio } from "@/components/practice/replay/Portfolio";
import { endDayExitText, portfolioRows } from "@/lib/replay/dayView";
import { problemMessage } from "@/lib/replay/setup";
import { clockControls, clockProgress, clockStateText, focusProgress, skippedText, type SkipDay } from "@/lib/replay/threadClock";
import { formatBalance } from "@/lib/replay/threadView";
import type { ThreadClockApi } from "@/lib/replay/useThreadClock";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/**
 * The day thread's clock and its whole control board, on the Summary and nowhere else (ADR-0018): Play or Pause, the speed (1x, 2x, 5x, 10x),
 * Skip day and End day for the whole thread. The board is always here: no stock has to be opened first. The clock is real time, shifted. It
 * shows the full date and the time to the second, and it ticks every second through the close, after-hours, the night and the weekend; on a
 * thread made with Hide dates it shows the weekday and the time only while a day is open (`datesHidden`: the day ending is the reveal); the
 * gap to real time never changes unless she pauses it, speeds it up or skips a day. The time is the server's: it keeps running when this page
 * is closed or she signs out, and this panel only asks for changes and shows the answer (polled every two seconds). Skip day jumps to the next
 * session's start and ends the day; End day stops at the clock, exits what is open at that price and opens the day's review. The plan's
 * practice window is a mark on the track, not a stop. The simulated account beside it is priced at that clock.
 */
export function ThreadClockPanel({ api, datesHidden, onSkipped }: { api: ThreadClockApi; /** The thread was made with Hide dates: no calendar date while a day is open (D-155). */ datesHidden: boolean; onSkipped: (result: SkipDay) => void }) {
  const { clock, shown } = api;
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [skipping, setSkipping] = useState(false);
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
        {api.error !== null ? (
          <ErrorBlock message={PRACTICE_COPY.clockLoadError} onRetry={api.refresh} />
        ) : (
          api.loading && <LoadingBlock label={PRACTICE_COPY.clockLoading} height={64} />
        )}
      </section>
    );
  }
  const can = clockControls(clock);
  const running = clock.state === "running";
  const focus = focusProgress(clock);
  const account = clock.account;
  const exits = portfolio.data === null ? null : endDayExitText(portfolioRows(portfolio.data), clock.clock);
  // A read that failed leaves the clock held at its last confirmed time: nothing is sent to a clock the page cannot see.
  const busy = api.busy || ending || api.stale;
  const speed = clock.speed;
  const dayListId = clock.day_list_id;

  async function skip() {
    setSkipping(true);
    const result = await api.skipDay();
    setSkipping(false);
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

      {can.started && (
        <>
          <p className={o.clockTime}>
            <span data-testid="thread-clock-time">{formatEtDateClock(shown, { hideDate: datesHidden })}</span>
          </p>
          <p className={hub.hint} data-testid="thread-clock-replayed">{PRACTICE_COPY.clockReplayedDate}</p>
          {api.stale && <p className={o.placeLine} role="status" data-testid="thread-clock-frozen">{practiceText("clockFrozen", { time: formatEtDateClock(shown, { hideDate: datesHidden }) })}</p>}
          <div className={o.clockTrack} role="progressbar" aria-label="Day progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clockProgress(clock, shown) * 100)}>
            <div className={o.clockFill} style={{ width: `${clockProgress(clock, shown) * 100}%` }} />
            {focus !== null && <span className={o.clockFocus} style={{ left: `${focus * 100}%` }} title={clock.focus_end === null ? undefined : practiceText("clockFocusMark", { time: formatEtTime(clock.focus_end) })} data-testid="thread-clock-focus" />}
          </div>
          {clock.focus_end !== null && <p className={hub.hint}>{practiceText("clockFocusMark", { time: formatEtTime(clock.focus_end) })}</p>}
          <p className={hub.hint} data-testid="thread-clock-next">
            {clock.next_start !== null ? practiceText("clockNextStart", { when: formatEtDateClock(clock.next_start, { seconds: false, hideDate: datesHidden }) }) : PRACTICE_COPY.clockLastDay}
          </p>
        </>
      )}

      {clock.state !== "no_day" && (
        <div className={o.clockControls} role="group" aria-label="Clock controls">
          <Button size="touch" variant="primary" disabled={!can.play || busy} aria-label={running ? PRACTICE_COPY.clockPause : PRACTICE_COPY.clockPlay} onClick={() => void (running ? api.pause() : api.play())}>
            {running ? PRACTICE_COPY.clockPause : PRACTICE_COPY.clockPlay}
          </Button>
          <SpeedChips speed={speed} onSpeed={(next) => void api.setSpeed(next)} />
          <Button ref={skipRef} size="touch" loading={skipping} disabled={!can.skip || busy || confirming || confirmingEnd} onClick={() => setConfirming(true)}>{skipping ? PRACTICE_COPY.clockSkipping : PRACTICE_COPY.clockSkipDay}</Button>
          <Button ref={endRef} size="touch" disabled={!can.skip || busy || confirming || confirmingEnd} aria-expanded={confirmingEnd} onClick={() => setConfirmingEnd(true)}>{PRACTICE_COPY.clockEndDay}</Button>
        </div>
      )}

      {confirming && (
        <InlineConfirm
          label="Confirm skipping the day"
          prompt={PRACTICE_COPY.clockSkipAsk}
          confirmLabel={skipping ? PRACTICE_COPY.clockSkipping : PRACTICE_COPY.clockSkipConfirm}
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
              <span>{practiceText("clockEndAsk", { clock: formatEtDateClock(shown, { hideDate: datesHidden }) })}</span>
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

      {clock.state === "paused" && !skipping && <p className={hub.hint} data-testid="thread-clock-paused-hint">{PRACTICE_COPY.clockPausedHint}</p>}
      {skipping && <p className={o.placeLine} role="status">{PRACTICE_COPY.clockSkippingNote}</p>}
      {api.rolled && <p className={o.placeLine} role="status" data-testid="thread-clock-rolled">{api.rolled}</p>}
      {note && <p className={o.placeLine} role="status">{note}</p>}
      {api.error && !api.stale && <p className={o.placeLine} role="alert">{api.error}</p>}
      {endError && <p className={o.placeLine} role="alert">{endError}</p>}

      {account && can.started && (
        // The headline above is the Equity and the line under it the Open P/L and the Balance (ADR-0018): this list only adds what they do not say (D-175).
        <div className={o.account} data-testid="thread-clock-account">
          <FactList
            className={o.accountList}
            facts={[
              {
                id: "buying-power",
                label: PRACTICE_COPY.clockAccountBuyingPower,
                value: (
                  <>
                    <span data-testid="thread-clock-buying-power">{formatBalance(account.buying_power_usd)}</span>
                    <SimulatedBadge />
                  </>
                ),
              },
            ]}
          />
          <p className={hub.hint}>{PRACTICE_COPY.clockAccountHint}</p>
        </div>
      )}
      <p className={hub.hint}>{PRACTICE_COPY.clockHint}</p>
    </section>
  );
}
