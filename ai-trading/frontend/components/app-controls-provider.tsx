"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { createControlsController, type AppId, type ControlsController, type ControlsState } from "@/lib/controls";

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

// Single session-scoped owner of fetching, polling and refresh for the whole
// authenticated app: one PageShell render owns one of these, so cards,
// detail pages and the Settings panel all read the same snapshot instead of
// each issuing its own request.
//
// This component is a thin wrapper: every load/change/poll/ordering decision
// lives in `createControlsController` (lib/controls.ts), a plain,
// framework-free function this is the one production caller of -- not a
// parallel reimplementation. One controller is created per Clerk session (so
// a session switch gets a clean instance rather than a shared one wrestled
// back to a fresh state); its callbacks are wired straight to React state,
// and `stop()` both tears down its timer/in-flight request and makes every
// pending/future callback from that instance a no-op.
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

  // `getToken` from Clerk is not guaranteed referentially stable; the
  // controller's long-lived `getToken` callback always calls through to
  // whatever this ref currently holds, written only from an effect
  // (react-hooks/refs), so the controller itself never needs recreating
  // just because this function identity changed.
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const controllerRef = useRef<ControlsController | null>(null);

  useEffect(() => {
    const controller = createControlsController({
      getToken: () => getTokenRef.current(),
      onState: setState,
      onLoading: setLoading,
      onError: setError,
      onMutating: setMutating,
    });
    controllerRef.current = controller;
    controller.start();

    function onFocus() {
      controller.handleFocus();
    }
    window.addEventListener("focus", onFocus);

    return () => {
      controller.stop();
      window.removeEventListener("focus", onFocus);
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [sessionId]);

  const refresh = useCallback(() => {
    void controllerRef.current?.load();
  }, []);

  const change = useCallback((id: AppId, enabled: boolean) => {
    if (!controllerRef.current) return Promise.reject(new Error("App controls are not ready yet."));
    return controllerRef.current.change(id, enabled);
  }, []);

  return (
    <AppControlsContext.Provider value={{ state, loading, error, mutating, refresh, change }}>
      {children}
    </AppControlsContext.Provider>
  );
}
