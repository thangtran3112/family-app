"use client";

import { SpeedChips } from "@/components/practice/replay/SpeedChips";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FactList } from "@/components/ui/FactList";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { formatEtDateClock } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { atHorizon, clockControls, clockStateText, nextOpenChip } from "@/lib/replay/threadClock";
import { formatBalance } from "@/lib/replay/threadView";
import type { ThreadClockApi } from "@/lib/replay/useThreadClock";
import { ThreadJump } from "./ThreadJump";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/**
 * The freestyle thread's clock and its whole control board, on the Summary and nowhere else (ADR-0018, ADR-0025): Play or Pause, the speed
 * (1x, 2x, 5x, 10x), Next open and Jump for the whole thread. The board is always here: no stock has to be opened first. The clock is real
 * time, shifted. It shows the weekday, the date and the time to the second ("Fri 2026-10-23 · 1:22:24 AM ET"), and it ticks every second
 * through the close, after-hours, the night and the weekend; the gap to real time never changes unless she pauses it, speeds it up or
 * jumps. The time is the server's: it keeps running when this page is closed or she signs out, and this panel only asks for changes and
 * shows the answer (polled every two seconds). Next open is a Jump to the first 9:30 ET open after the clock; Jump moves the clock to a date and
 * time she types. Both go forward only, and no later than the horizon: the one place the clock stops on its own, because the data ends
 * there. Nothing a move crosses closes anything: every open position stays open and is priced at the new time. The account beside it is
 * priced at that clock.
 */
export function ThreadClockPanel({ api }: { api: ThreadClockApi }) {
  const { clock, shown } = api;

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
  const stopped = atHorizon(clock);
  // A read that failed leaves the clock held at its last confirmed time: nothing is sent to a clock the page cannot see.
  const busy = api.busy || api.stale;
  const next = nextOpenChip(clock);
  const open = account?.positions ?? 0;

  return (
    <section className={styles.panel} aria-label={PRACTICE_COPY.clockTitle} data-testid="thread-clock" data-state={clock.state}>
      <div className={o.sectionHead}>
        <h2 className={styles.panelTitle}>{PRACTICE_COPY.clockTitle}</h2>
        {clock.state !== "not_started" && <Badge tone={running ? "up" : "neutral"} data-testid="thread-clock-state">{clockStateText(clock)}</Badge>}
      </div>

      {clock.state === "not_started" && <p className={o.placeLine}>{PRACTICE_COPY.clockNotStarted}</p>}

      {can.started && (
        <>
          <p className={o.clockTime}>
            <span data-testid="thread-clock-time">{formatEtDateClock(shown)}</span>
          </p>
          {api.stale && <p className={o.placeLine} role="status" data-testid="thread-clock-frozen">{practiceText("clockFrozen", { time: formatEtDateClock(shown) })}</p>}
          {stopped && <p className={o.placeLine} role="status" data-testid="thread-clock-horizon">{practiceText("clockHorizonNote", { horizon: formatEtDateClock(clock.horizon, { seconds: false }) })}</p>}
        </>
      )}

      {can.started && (
        <div className={o.clockControls} role="group" aria-label="Clock controls">
          <Button size="touch" variant="primary" disabled={!can.play || busy} aria-label={running ? PRACTICE_COPY.clockPause : PRACTICE_COPY.clockPlay} onClick={() => void (running ? api.pause() : api.play())}>
            {running ? PRACTICE_COPY.clockPause : PRACTICE_COPY.clockPlay}
          </Button>
          <SpeedChips speed={clock.speed} onSpeed={(speed) => void api.setSpeed(speed)} />
          <Button
            size="touch"
            data-testid="thread-clock-next-open"
            disabled={next.to === null || busy}
            title={next.disabledReason ?? undefined}
            onClick={() => next.to !== null && void api.command({ to: next.to })}
          >
            {next.label}
          </Button>
        </div>
      )}
      {can.started && next.disabledReason !== null && <p className={hub.hint} data-testid="thread-clock-next-none">{next.disabledReason}</p>}
      {can.started && open > 0 && (
        <p className={hub.hint} data-testid="thread-clock-stays">{open === 1 ? PRACTICE_COPY.clockNextOpenStaysOne : practiceText("clockNextOpenStays", { count: open })}</p>
      )}

      {can.started && <ThreadJump clock={clock} shown={shown} busy={busy} onJump={(to) => api.command({ to })} />}

      {clock.state === "paused" && !stopped && <p className={hub.hint} data-testid="thread-clock-paused-hint">{PRACTICE_COPY.clockPausedHint}</p>}
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
