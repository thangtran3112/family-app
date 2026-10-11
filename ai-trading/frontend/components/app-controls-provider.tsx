"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { changeApp, fetchApps, type AppId, type ControlsState } from "@/lib/controls";

const IDLE_POLL_MS = 30_000;
const ACTIVE_POLL_MS = 2_000;

type AppControlsContextValue = {
  state: ControlsState | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  change: (id: AppId, enabled: boolean) => Promise<void>;
};

const AppControlsContext = createContext<AppControlsContextValue | null>(null);

export function useAppControls(): AppControlsContextValue {
  const value = useContext(AppControlsContext);
  if (!value) throw new Error("App controls require AppControlsProvider");
  return value;
}

function hasActiveTransition(state: ControlsState | null): boolean {
  return !!state?.apps.some((app) => app.status === "Starting" || app.status === "Stopping");
}

// Single session-scoped owner of fetching, polling and refresh for the whole
// authenticated app: one PageShell render owns one of these, so cards,
// detail pages and the Settings panel all read the same snapshot instead of
// each issuing its own request. Polls every 30s while idle, every 2s while
// any app is Starting/Stopping, and immediately on window focus. A stale
// in-flight read is aborted before a newer one starts, and any response that
// arrives after the session has moved on is ignored rather than applied.
export function AppControlsProvider({ children }: { children: ReactNode }) {
  const { getToken, sessionId: rawSessionId } = useAuth();
  const sessionId = rawSessionId ?? null;

  const [state, setState] = useState<ControlsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Session-scoped reset, the same "adjust state during render" pattern
  // AuthGate's resetForSession uses: the instant the Clerk session changes,
  // demote to loading in this same render, before a stale previous-session
  // snapshot could otherwise flash.
  const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
  if (sessionId !== renderedSessionId) {
    setRenderedSessionId(sessionId);
    setState(null);
    setError(null);
    setLoading(true);
  }

  // Refs give the imperative polling/abort logic below access to each
  // render's latest value without re-running effects on every change; they
  // are written only from effects (never during render) so a React
  // Compiler-memoized render can never skip a write.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    const ownerSession = sessionIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    fetchApps(() => getToken(), fetch, controller.signal).then(
      (next) => {
        if (controller.signal.aborted || sessionIdRef.current !== ownerSession) return;
        setState(next);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) return;
        if (sessionIdRef.current !== ownerSession) return;
        setError(err instanceof Error ? err.message : "App controls are unavailable.");
        setLoading(false);
      },
    );
  }, [getToken]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function scheduleNext() {
      const delay = hasActiveTransition(stateRef.current) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      timer = setTimeout(runPoll, delay);
    }
    function runPoll() {
      if (cancelled) return;
      loadRef.current();
      scheduleNext();
    }
    function onFocus() {
      if (!cancelled) loadRef.current();
    }

    loadRef.current();
    scheduleNext();
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      abortRef.current?.abort();
    };
  }, [sessionId]);

  const change = useCallback(
    async (id: AppId, enabled: boolean) => {
      const current = stateRef.current;
      if (!current) throw new Error("App controls are not loaded yet.");
      const next = await changeApp(id, enabled, current.revision, () => getToken(), fetch);
      if (sessionIdRef.current !== sessionId) return;
      setState(next);
      setError(null);
    },
    [getToken, sessionId],
  );

  return (
    <AppControlsContext.Provider value={{ state, loading, error, refresh: load, change }}>
      {children}
    </AppControlsContext.Provider>
  );
}
