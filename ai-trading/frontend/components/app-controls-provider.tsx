"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { changeApp, createGenerationGate, fetchApps, nextPollDelayMs, type AppId, type ControlsState } from "@/lib/controls";

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
// Response ordering (fix round 1, Important #2): every read AND every
// mutation takes a ticket from one `GenerationGate` (lib/controls.ts)
// *before* its own request goes out, and only applies its result if that
// ticket is still the newest one issued by the time it resolves. A mutation
// also aborts whatever read is currently in flight. Together these mean a
// GET that happens to resolve after a PUT can never overwrite it, and two
// overlapping reads can never apply out of order -- regardless of which
// request's response happens to arrive first, and without relying on
// revision (a completed operation doesn't bump it by itself).
//
// Polling cadence (fix round 1, Important #1): `nextPollDelayMs` is called
// with the just-settled snapshot (or null on failure) *after* a read
// completes, never from a value captured before the request was even sent --
// so a transition snapshot speeds the very next scheduled poll up to 2s, and
// the first settled snapshot back to idle slows it back down to 30s. A
// successful mutation also immediately reschedules the pending timer from
// its own resulting snapshot (via `rescheduleRef`), so a 202 response that
// starts a transition doesn't wait for the next background poll to speed up.
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
  const gateRef = useRef(createGenerationGate());
  const rescheduleRef = useRef<((result: ControlsState | null) => void) | null>(null);

  // Returns the settled snapshot (or null on failure/stale) so pollers can
  // compute the next cadence from the actual outcome of *this* read.
  const load = useCallback(async (): Promise<ControlsState | null> => {
    const ownerSession = sessionIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const ticket = gateRef.current.begin();
    setLoading(true);
    try {
      const next = await fetchApps(() => getToken(), fetch, controller.signal);
      if (!gateRef.current.accepts(ticket) || sessionIdRef.current !== ownerSession) return null;
      setState(next);
      setError(null);
      setLoading(false);
      return next;
    } catch (err) {
      if (isAbortError(err) || !gateRef.current.accepts(ticket) || sessionIdRef.current !== ownerSession) return null;
      setError(err instanceof Error ? err.message : "App controls are unavailable.");
      setLoading(false);
      return null;
    }
  }, [getToken]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function schedule(result: ControlsState | null) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void cycle(), nextPollDelayMs(result));
    }
    async function cycle() {
      if (cancelled) return;
      const result = await loadRef.current();
      if (cancelled) return;
      schedule(result);
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
      // A pending read must never be allowed to resolve after, and overwrite,
      // this mutation's result: abort it and take a newer ticket before the
      // request is even sent.
      abortRef.current?.abort();
      const ticket = gateRef.current.begin();
      setMutating(true);
      try {
        const next = await changeApp(id, enabled, current.revision, () => getToken(), fetch);
        if (!gateRef.current.accepts(ticket) || sessionIdRef.current !== ownerSession) return;
        setState(next);
        setError(null);
        rescheduleRef.current?.(next);
      } finally {
        setMutating(false);
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
