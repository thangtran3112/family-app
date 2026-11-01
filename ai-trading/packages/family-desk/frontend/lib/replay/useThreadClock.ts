"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRACTICE_COPY } from "../desk/freshness.ts";
import type { Speed } from "./clock.ts";
import { problemMessage } from "./setup.ts";
import { commandThreadClock, extrapolate, loadThreadClock, skipThreadDay, type ClockCommand, type SkipDay, type ThreadClock } from "./threadClock.ts";

// The Summary's view of the day thread's server-side clock (ADR-0018). RECOMMENDATION, polling: the server settles the clock lazily on
// every read, so a poll is one idempotent request and needs no connection, and no-lookahead rules out pricing a balance in the browser
// (it would need prices after the clock). The page asks every POLL_MS while it is visible, and at once when it becomes visible again.
// Between polls only the TIME LABEL moves (`extrapolate`). Nothing here starts, stops or keeps the clock: leaving the page or signing
// out changes nothing on the server.

export const POLL_MS = 2000;
const LABEL_MS = 1000;

export type ThreadClockApi = {
  clock: ThreadClock | null;
  /** The clock label right now: the server's time moved on by the wall time since the last poll. */
  shown: string | null;
  /** Counts up whenever the server's clock or state changed, so a screen that prices things at the clock can read again. */
  revision: number;
  loading: boolean;
  error: string | null;
  busy: boolean;
  command: (command: ClockCommand) => Promise<boolean>;
  play: () => Promise<boolean>;
  pause: () => Promise<boolean>;
  setSpeed: (speed: Speed) => Promise<boolean>;
  step: () => Promise<boolean>;
  nextSignal: () => Promise<boolean>;
  jumpBy: (minutes: number) => Promise<boolean>;
  jumpTo: (iso: string) => Promise<boolean>;
  skipDay: () => Promise<SkipDay | null>;
  refresh: () => void;
};

/** `threadId` null: no clock (a swing thread, or no thread). */
export function useThreadClock(threadId: number | null): ThreadClockApi {
  const [snapshot, setSnapshot] = useState<{ clock: ThreadClock; at: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(threadId !== null);
  const seen = useRef<string>("");
  const alive = useRef(true);

  const take = useCallback((clock: ThreadClock) => {
    setSnapshot({ clock, at: Date.now() });
    setNow(Date.now());
    setError(null);
    setLoading(false);
    const key = `${clock.day_list_id}|${clock.state}|${clock.speed}|${clock.clock}|${clock.account?.equity_usd}`;
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
    void read(controller.signal);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void read(controller.signal);
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void read(controller.signal);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [threadId, read]);

  const running = snapshot?.clock.state === "running";
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

  const skipDay = useCallback(async (): Promise<SkipDay | null> => {
    if (threadId === null) return null;
    setBusy(true);
    try {
      const result = await skipThreadDay(threadId);
      take(result.clock);
      return result;
    } catch (failure) {
      if (alive.current) setError(problemMessage(failure, PRACTICE_COPY.clockActionError));
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [threadId, take]);

  const shown = snapshot === null ? null : extrapolate(snapshot.clock, now - snapshot.at);
  const clockNow = snapshot?.clock ?? null;
  return useMemo(
    () => ({
      clock: clockNow,
      shown,
      revision,
      loading,
      error,
      busy,
      command,
      play: () => command({ running: true }),
      pause: () => command({ running: false }),
      setSpeed: (speed: Speed) => command({ speed }),
      step: () => command({ step: "bar" }),
      nextSignal: () => command({ step: "next_signal" }),
      jumpBy: (minutes: number) => command({ to: new Date(Date.parse(shown ?? clockNow?.clock ?? new Date().toISOString()) + minutes * 60_000).toISOString() }),
      jumpTo: (iso: string) => command({ to: iso }),
      skipDay,
      refresh: () => void read(),
    }),
    [clockNow, shown, revision, loading, error, busy, command, skipDay, read],
  );
}
