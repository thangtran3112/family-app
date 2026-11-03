"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backoffMs } from "../desk/backoff.ts";
import { PRACTICE_COPY } from "../desk/freshness.ts";
import type { Speed } from "./clock.ts";
import { problemMessage } from "./setup.ts";
import { ms } from "./time.ts";
import { commandThreadClock, loadThreadClock, shownClock, type ClockCommand, type ThreadClock } from "./threadClock.ts";

// The Summary's view of the freestyle thread's server-side clock (ADR-0018, ADR-0025). RECOMMENDATION, polling: the server settles the clock lazily on
// every read, so a poll is one idempotent request and needs no connection, and no-lookahead rules out pricing a balance in the browser
// (it would need prices after the clock). The page asks every POLL_MS while it is visible, and at once when it becomes visible again.
// Between polls only the TIME LABEL moves (`extrapolate`). Nothing here starts, stops or keeps the clock: leaving the page or signing
// out changes nothing on the server. A read that fails does not stop the clock on the server, but this page can no longer confirm it: the
// label is HELD at the last time the server confirmed (`stale`) instead of running on unconfirmed, and the next poll waits twice as long
// after each failure (`backoffMs`) until an answer comes back.

export const POLL_MS = 2000;
const LABEL_MS = 1000;

export type ThreadClockApi = {
  clock: ThreadClock | null;
  /** The clock label right now: the server's time moved on by the wall time since the last poll. */
  shown: string | null;
  /** The last read failed: `shown` is held at the last time the server confirmed (`clock.clock`) and the controls wait for an answer. */
  stale: boolean;
  /** Counts up whenever the server's clock minute or state changed, so a screen that prices things at the clock can read again. */
  revision: number;
  loading: boolean;
  error: string | null;
  busy: boolean;
  command: (command: ClockCommand) => Promise<boolean>;
  play: () => Promise<boolean>;
  pause: () => Promise<boolean>;
  setSpeed: (speed: Speed) => Promise<boolean>;
  refresh: () => void;
};

/** `threadId` null: no clock (no thread, or a closed one). */
export function useThreadClock(threadId: number | null): ThreadClockApi {
  const [snapshot, setSnapshot] = useState<{ clock: ThreadClock; at: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(threadId !== null);
  const [stale, setStale] = useState(false);
  const seen = useRef<string>("");
  const alive = useRef(true);
  const failures = useRef(0);

  const take = useCallback((clock: ThreadClock) => {
    setSnapshot({ clock, at: Date.now() });
    setNow(Date.now());
    setError(null);
    setStale(false);
    failures.current = 0;
    setLoading(false);
    // The clock's MINUTE, not its second: prices change when a bar closes, and a screen that reads the whole book again on every revision (the
    // Portfolio) would have each read cancelled by the next poll's, so its "as of" never moved.
    const minute = clock.clock === null ? null : Math.floor(ms(clock.clock) / 60_000);
    const key = `${clock.state}|${clock.speed}|${minute}|${clock.pause?.kind ?? ""}|${clock.account?.equity_usd}|${clock.account?.buying_power_usd}`;
    if (key !== seen.current) {
      seen.current = key;
      setRevision((n) => n + 1);
    }
  }, []);

  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (threadId === null) return;
      try {
        take(await loadThreadClock(threadId, { signal }));
      } catch {
        if (alive.current && !signal?.aborted) {
          failures.current += 1;
          setStale(true);
          setError(PRACTICE_COPY.clockLoadError);
          setLoading(false);
        }
      }
    },
    [threadId, take],
  );

  useEffect(() => {
    alive.current = true;
    if (threadId === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One poll at a time: the next waits for this one's answer, then the poll interval, doubled per failure in a row.
    const tick = async () => {
      if (document.visibilityState === "visible") await read(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), backoffMs(POLL_MS, failures.current));
    };
    timer = setTimeout(() => void tick(), 0); // after this effect, so the first answer is not a setState inside it
    const onVisible = () => {
      if (document.visibilityState === "visible") void read(controller.signal);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [threadId, read]);

  const running = snapshot?.clock.state === "running" && !stale;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), LABEL_MS);
    return () => clearInterval(timer);
  }, [running]);

  const command = useCallback(
    async (body: ClockCommand): Promise<boolean> => {
      if (threadId === null) return false;
      setBusy(true);
      try {
        take(await commandThreadClock(threadId, body));
        return true;
      } catch (failure) {
        if (alive.current) setError(problemMessage(failure, PRACTICE_COPY.clockActionError));
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [threadId, take],
  );

  // Held at the last confirmed time while a read is failing: a clock that keeps running with no answer behind it is a guess.
  const shown = snapshot === null ? null : shownClock(snapshot.clock, now - snapshot.at, stale);
  const clockNow = snapshot?.clock ?? null;
  return useMemo(
    () => ({
      clock: clockNow,
      shown,
      stale,
      revision,
      loading,
      error,
      busy,
      command,
      play: () => command({ running: true }),
      pause: () => command({ running: false }),
      setSpeed: (speed: Speed) => command({ speed }),
      refresh: () => void read(),
    }),
    [clockNow, shown, stale, revision, loading, error, busy, command, read],
  );
}
