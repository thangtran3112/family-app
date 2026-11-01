"use client";

import { useRef, useState } from "react";
import { JumpMenu } from "@/components/practice/replay/JumpMenu";
import { SpeedChips } from "@/components/practice/replay/SpeedChips";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FactList } from "@/components/ui/FactList";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import { formatEtClock } from "@/lib/desk/format";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { etDayOf, etWallToUtcIso } from "@/lib/replay/time";
import { clockControls, clockProgress, clockStateText, pauseText, skippedText, type SkipDay } from "@/lib/replay/threadClock";
import { formatBalance, formatDayResult } from "@/lib/replay/threadView";
import type { ThreadClockApi } from "@/lib/replay/useThreadClock";
import styles from "./landing.module.css";
import o from "./overview.module.css";

/**
 * The day thread's clock and its controls, on the Summary and nowhere else (ADR-0018): Play or Pause, Step, speed, Jump and Skip day for
 * the whole thread. The time is the server's. It keeps running when this page is closed or she signs out; this panel only asks
 * for changes and shows the answer (polled every two seconds). The simulated account beside it is priced at that clock.
 */
export function ThreadClockPanel({ api, onSkipped }: { api: ThreadClockApi; onSkipped: (result: SkipDay) => void }) {
  const { clock, shown } = api;
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const skipRef = useRef<HTMLButtonElement>(null);

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
  const pause = pauseText(clock.pause);
  const account = clock.account;
  const busy = api.busy;
  const speed = clock.speed;

  async function skip() {
    const result = await api.skipDay();
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

      {clock.state === "no_day" && <p className={o.placeLine}>{PRACTICE_COPY.clockNoDay}</p>}
      {clock.state === "listed" && <p className={o.placeLine}>{PRACTICE_COPY.clockNotStarted}</p>}

      {can.started && (
        <>
          <p className={o.clockTime}>
            <span data-testid="thread-clock-time">{formatEtClock(shown)}</span>
          </p>
          <div className={o.clockTrack} role="progressbar" aria-label="Day progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clockProgress(clock, shown) * 100)}>
            <div className={o.clockFill} style={{ width: `${clockProgress(clock, shown) * 100}%` }} />
          </div>
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
          <Button ref={skipRef} size="touch" disabled={!can.skip || busy || confirming} onClick={() => setConfirming(true)}>{PRACTICE_COPY.clockSkipDay}</Button>
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

      {pause && <p className={o.placeLine} role="status" data-testid="thread-clock-pause">{pause}</p>}
      {note && <p className={o.placeLine} role="status">{note}</p>}
      {api.error && <p className={o.placeLine} role="alert">{api.error}</p>}

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
