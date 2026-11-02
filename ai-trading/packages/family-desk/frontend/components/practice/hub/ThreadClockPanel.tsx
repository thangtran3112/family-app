"use client";

import { useRef, useState } from "react";
import { SpeedChips } from "@/components/practice/replay/SpeedChips";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FactList } from "@/components/ui/FactList";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { formatEtDateClock } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { clockControls, clockProgress, clockStateText, isLastDay, skippedText, type SkipDay } from "@/lib/replay/threadClock";
import { formatBalance } from "@/lib/replay/threadView";
import type { ThreadClockApi } from "@/lib/replay/useThreadClock";
import { ThreadJump } from "./ThreadJump";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/**
 * The day thread's clock and its whole control board, on the Summary and nowhere else (ADR-0018): Play or Pause, the speed (1x, 2x, 5x, 10x),
 * Skip day and Jump for the whole thread. The board is always here: no stock has to be opened first. The clock is real time, shifted. It
 * shows the weekday, the date and the time to the second ("Fri 2026-10-23 · 1:22:24 AM ET"), and it ticks every second through the close,
 * after-hours, the night and the weekend; the gap to real time never changes unless she pauses it, speeds it up or skips a day. The time is the server's: it keeps running when this page
 * is closed or she signs out, and this panel only asks for changes and shows the answer (polled every two seconds). Skip day jumps to the next
 * market open and ends the day; Jump moves the clock to a date and time she types, forward only and no later than the plan's end. There is no
 * End day (ADR-0023): a day ends where the clock reaches the next open, by itself, by a skip or by a jump. The plan's simulated account beside it
 * is priced at that clock.
 */
export function ThreadClockPanel({
  api,
  preparing = false,
  onSkipped,
}: {
  api: ThreadClockApi;
  /** The first day's data is still being prepared: no Start button exists yet, so the card does not tell her to press one (D-182). */
  preparing?: boolean;
  onSkipped: (result: SkipDay) => void;
}) {
  const { clock, shown } = api;
  const [confirming, setConfirming] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const skipRef = useRef<HTMLButtonElement>(null);

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
  const account = clock.account;
  // A read that failed leaves the clock held at its last confirmed time: nothing is sent to a clock the page cannot see.
  const busy = api.busy || api.stale;
  const speed = clock.speed;

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

  return (
    <section className={styles.panel} aria-label={PRACTICE_COPY.clockTitle} data-testid="thread-clock" data-state={clock.state}>
      <div className={o.sectionHead}>
        <h2 className={styles.panelTitle}>{PRACTICE_COPY.clockTitle}</h2>
        {clock.state !== "no_day" && <Badge tone={running ? "up" : "neutral"} data-testid="thread-clock-state">{clockStateText(clock)}</Badge>}
      </div>

      {clock.state === "no_day" && <p className={o.placeLine}>{preparing ? PRACTICE_COPY.clockPreparing : PRACTICE_COPY.clockNoDay}</p>}

      {can.started && (
        <>
          <p className={o.clockTime}>
            <span data-testid="thread-clock-time">{formatEtDateClock(shown)}</span>
          </p>
          {api.stale && <p className={o.placeLine} role="status" data-testid="thread-clock-frozen">{practiceText("clockFrozen", { time: formatEtDateClock(shown) })}</p>}
          <div className={o.clockTrack} role="progressbar" aria-label="Day progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clockProgress(clock, shown) * 100)}>
            <div className={o.clockFill} style={{ width: `${clockProgress(clock, shown) * 100}%` }} />
          </div>
          <p className={hub.hint} data-testid="thread-clock-next">
            {clock.next_start !== null && practiceText(isLastDay(clock) ? "clockLastDay" : "clockNextStart", { when: formatEtDateClock(clock.next_start, { seconds: false }) })}
          </p>
        </>
      )}

      {clock.state !== "no_day" && (
        <div className={o.clockControls} role="group" aria-label="Clock controls">
          <Button size="touch" variant="primary" disabled={!can.play || busy} aria-label={running ? PRACTICE_COPY.clockPause : PRACTICE_COPY.clockPlay} onClick={() => void (running ? api.pause() : api.play())}>
            {running ? PRACTICE_COPY.clockPause : PRACTICE_COPY.clockPlay}
          </Button>
          <SpeedChips speed={speed} onSpeed={(next) => void api.setSpeed(next)} />
          <Button ref={skipRef} size="touch" loading={skipping} disabled={!can.skip || busy || confirming} aria-expanded={confirming} onClick={() => setConfirming(true)}>{skipping ? PRACTICE_COPY.clockSkipping : PRACTICE_COPY.clockSkipDay}</Button>
        </div>
      )}

      {can.started && <ThreadJump clock={clock} shown={shown} busy={busy} onJump={(to) => api.command({ to })} />}

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

      {clock.state === "paused" && !skipping && <p className={hub.hint} data-testid="thread-clock-paused-hint">{PRACTICE_COPY.clockPausedHint}</p>}
      {skipping && <p className={o.placeLine} role="status">{PRACTICE_COPY.clockSkippingNote}</p>}
      {api.rolled && <p className={o.placeLine} role="status" data-testid="thread-clock-rolled">{api.rolled}</p>}
      {note && <p className={o.placeLine} role="status">{note}</p>}
      {api.error && !api.stale && <p className={o.placeLine} role="alert">{api.error}</p>}

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
