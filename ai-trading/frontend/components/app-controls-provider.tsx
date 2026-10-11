"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { changeApp, createControlsScheduler, fetchApps, nextPollDelayMs, pollDelayAfter, type AppId, type ControlsState, type ReadOutcome } from "@/lib/controls";

type AppControlsContextValue = {
  state: ControlsState | null;
  loading: boolean;
  error: string | null;
  mutating: boolean;
  refresh: () => void;
  change: (id: AppId, enabled: boolean) => Promise<void>;
};

const AppControlsContext = createContext<AppControlsContextValue | null>(null);

export function useAppControls(): AppControlsContextValue {
  const value = useContext(AppControlsContext);
  if (!value) throw new Error("App controls require AppControlsProvider");
  return value;
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

// Single session-scoped owner of fetching, polling and refresh for the whole
// authenticated app: one PageShell render owns one of these, so cards,
// detail pages and the Settings panel all read the same snapshot instead of
// each issuing its own request.
//
// Response ordering & mutation exclusivity (fix round 2, Important #1):
// `createControlsScheduler` (lib/controls.ts) is the one production
// authority both `load()` and `change()` defer to. A read is refused
// outright (`attemptRead()` returns null, no ticket taken) while a mutation
// is in flight, rather than merely racing it on ticket order -- fix round
// 1's plain ticket counter alone let a focus/timer read begun *during* a
// pending PUT take a newer ticket than the PUT's, discarding the PUT's own
// successful snapshot once it settled. `change()` still aborts whatever read
// may already have been in flight *before* it began, and always calls
// `endMutation()` (success or failure) so a new read can start again.
//
// Cycle scheduling (fix round 2, Important #2): `cycle()` only ever calls
// `schedule()` for an "applied" or "failed" outcome; a "stale" one (this
// read was invalidated by a newer read or a mutation) is a no-op for
// scheduling too -- `pollDelayAfter` encodes exactly this, so an aborted
// pre-mutation cycle can never replace the mutation's own 2s transition
// reschedule with a stray 30s idle timer.
export function AppControlsProvider({ children }: { children: ReactNode }) {
  const { getToken, sessionId: rawSessionId } = useAuth();
  const sessionId = rawSessionId ?? null;

  const [state, setState] = useState<ControlsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);

  // Session-scoped reset, the same "adjust state during render" pattern
  // AuthGate's resetForSession uses: the instant the Clerk session changes,
  // demote to loading in this same render, before a stale previous-session
  // snapshot could otherwise flash. (Writing state here, not in an effect,
  // is what satisfies eslint-config-next's react-hooks/set-state-in-effect.)
  const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
  if (sessionId !== renderedSessionId) {
    setRenderedSessionId(sessionId);
    setState(null);
    setError(null);
    setLoading(true);
    setMutating(false);
  }

  // Refs give the imperative polling/abort/ordering logic below access to
  // each render's latest value without re-running effects on every change;
  // they are written only from effects (never during render), so a React
  // Compiler-memoized render can never skip a write (react-hooks/refs).
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const abortRef = useRef<AbortController | null>(null);
  const schedulerRef = useRef(createControlsScheduler());
  const rescheduleRef = useRef<((result: ControlsState | null) => void) | null>(null);

  // Returns a discriminated outcome so pollers can tell "nothing to
  // reschedule from, someone newer already owns it" apart from "genuinely
  // failed, schedule the idle cadence".
  const load = useCallback(async (): Promise<ReadOutcome> => {
    const attempt = schedulerRef.current.attemptRead();
    if (!attempt) return { kind: "stale" }; // a mutation is pending; this read never started
    const ownerSession = sessionIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const next = await fetchApps(() => getToken(), fetch, controller.signal);
      if (!schedulerRef.current.isCurrent(attempt.ticket) || sessionIdRef.current !== ownerSession) return { kind: "stale" };
      setState(next);
      setError(null);
      setLoading(false);
      return { kind: "applied", state: next };
    } catch (err) {
      if (isAbortError(err) || !schedulerRef.current.isCurrent(attempt.ticket) || sessionIdRef.current !== ownerSession) {
        return { kind: "stale" };
      }
      setError(err instanceof Error ? err.message : "App controls are unavailable.");
      setLoading(false);
      return { kind: "failed" };
    }
  }, [getToken]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function scheduleAt(delay: number) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void cycle(), delay);
    }
    // Used for an *intentional* reschedule (a mutation's own settled
    // outcome, success or failure) -- never "stale", so it always schedules,
    // unlike `cycle()`'s own use of `pollDelayAfter` below.
    function schedule(result: ControlsState | null) {
      scheduleAt(nextPollDelayMs(result));
    }
    async function cycle() {
      if (cancelled) return;
      const outcome = await loadRef.current();
      if (cancelled) return;
      const delay = pollDelayAfter(outcome);
      if (delay === null) return; // stale: a newer read or a mutation already owns scheduling
      scheduleAt(delay);
    }
    function onFocus() {
      if (cancelled) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      void cycle();
    }

    rescheduleRef.current = schedule;
    void cycle();
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      if (rescheduleRef.current === schedule) rescheduleRef.current = null;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      abortRef.current?.abort();
    };
  }, [sessionId]);

  const change = useCallback(
    async (id: AppId, enabled: boolean) => {
      const current = stateRef.current;
      if (!current) throw new Error("App controls are not loaded yet.");
      const ownerSession = sessionIdRef.current;
      // A pending read must never be allowed to resolve after, and
      // overwrite, this mutation's result: abort it and take a newer ticket
      // before the request is even sent. `beginMutation()` also blocks any
      // *new* read from starting until `endMutation()` runs below.
      abortRef.current?.abort();
      const ticket = schedulerRef.current.beginMutation();
      setMutating(true);
      let applied: ControlsState | null = null;
      try {
        const next = await changeApp(id, enabled, current.revision, () => getToken(), fetch);
        if (!schedulerRef.current.isCurrent(ticket) || sessionIdRef.current !== ownerSession) return;
        setState(next);
        setError(null);
        applied = next;
      } finally {
        schedulerRef.current.endMutation();
        setMutating(false);
        // Reschedule from the mutation's own outcome (the fresh snapshot on
        // success, or the pre-mutation state as the best-known fallback on
        // failure) so background polling always has an active timer once
        // this mutation is no longer blocking new reads -- whether or not a
        // focus/timer attempt was refused while it was pending.
        if (schedulerRef.current.isCurrent(ticket) && sessionIdRef.current === ownerSession) {
          rescheduleRef.current?.(applied ?? current);
        }
      }
    },
    [getToken],
  );

  return (
    <AppControlsContext.Provider value={{ state, loading, error, mutating, refresh: () => void loadRef.current(), change }}>
      {children}
    </AppControlsContext.Provider>
  );
}
