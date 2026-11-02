"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRACTICE_COPY } from "../desk/freshness.ts";
import type { Speed } from "./clock.ts";
import { problemMessage } from "./setup.ts";
import { commandThreadClock, extrapolate, loadThreadClock, rolledText, skipThreadDay, type ClockCommand, type SkipDay, type ThreadClock } from "./threadClock.ts";

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
  /** Set when the clock reached the next session on its own since the last answer: the day that ended and where the next one stands. Stays until she skips a day or leaves the page: the next day is already open and running. */
  rolled: string | null;
  /** Counts up whenever the server's clock or state changed, so a screen that prices things at the clock can read again. */
  revision: number;
  loading: boolean;
  error: string | null;
  busy: boolean;
  command: (command: ClockCommand) => Promise<boolean>;
  play: () => Promise<boolean>;
  pause: () => Promise<boolean>;
  setSpeed: (speed: Speed) => Promise<boolean>;
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
  const [rolled, setRolled] = useState<string | null>(null);
  const seen = useRef<string>("");
  const day = useRef<{ id: number; no: number | null } | null>(null);
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

  // The clock reaching the next session is not a button: the server ends the day and opens the next. An answer whose open day is another one than the last
  // answer's (and that no Skip day of this screen caused) is that hand-over, and the screen says so once.
  const follow = useCallback(
    (clock: ThreadClock) => {
      const before = day.current;
      if (before !== null && clock.day_list_id !== before.id) setRolled(rolledText(before.no, clock));
      day.current = clock.day_list_id === null ? null : { id: clock.day_list_id, no: clock.day_no };
      take(clock);
    },
    [take],
  );

  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (threadId === null) return;
      try {
        follow(await loadThreadClock(threadId, { signal }));
      } catch {
        if (alive.current && !signal?.aborted) {
          setError(PRACTICE_COPY.clockLoadError);
          setLoading(false);
        }
      }
    },
    [threadId, follow],
  );

  useEffect(() => {
    alive.current = true;
    if (threadId === null) return;
    const controller = new AbortController();
    const first = setTimeout(() => void read(controller.signal), 0); // after this effect, so the first answer is not a setState inside it
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
      clearTimeout(first);
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
        follow(await commandThreadClock(threadId, body));
        return true;
      } catch (failure) {
        if (alive.current) setError(problemMessage(failure, PRACTICE_COPY.clockActionError));
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [threadId, follow],
  );

  const skipDay = useCallback(async (): Promise<SkipDay | null> => {
    if (threadId === null) return null;
    setBusy(true);
    try {
      const result = await skipThreadDay(threadId);
      day.current = result.clock.day_list_id === null ? null : { id: result.clock.day_list_id, no: result.clock.day_no };
      setRolled(null);
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
      rolled,
      revision,
      loading,
      error,
      busy,
      command,
      play: () => command({ running: true }),
      pause: () => command({ running: false }),
      setSpeed: (speed: Speed) => command({ speed }),
      skipDay,
      refresh: () => void read(),
    }),
    [clockNow, shown, rolled, revision, loading, error, busy, command, skipDay, read],
  );
}
