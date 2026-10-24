"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { connectionOf, initialQueryState, queryReducer, type QueryState } from "./queryState.ts";
import type { Connection } from "./freshness.ts";

export type DeskQueryOptions = {
  /** Refetch every this many ms while the tab is visible; old values stay on screen meanwhile. */
  intervalMs?: number;
  /** Skip fetching (for example until a symbol is known). */
  enabled?: boolean;
};

export type DeskQueryResult<T> = {
  data: T | null;
  error: unknown;
  /** First load, nothing to show yet. */
  loading: boolean;
  /** A refresh is in flight and `data` is the previous answer ("Updating quotes…"). */
  updating: boolean;
  /** The last refresh failed but `data` is still the previous answer ("Reconnecting…"). */
  connection: Connection;
  updatedAt: number | null;
  refresh: () => void;
};

/**
 * Fetch state plus an interval refetch that keeps old values on screen (02m §c4). `key` identifies
 * the request (symbol, timeframe, filter id): a new key starts from "loading" without the old data.
 */
export function useDeskQuery<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  { intervalMs, enabled = true }: DeskQueryOptions = {},
): DeskQueryResult<T> {
  const [raw, dispatch] = useReducer(queryReducer<T>, key, initialQueryState<T>);
  const fetcherRef = useRef(fetcher);
  const runRef = useRef<(background: boolean) => void>(() => undefined);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const run = (background: boolean) => {
      if (background) dispatch({ type: "start", key });
      fetcherRef.current(controller.signal).then(
        (data) => { if (!controller.signal.aborted) dispatch({ type: "success", key, data, at: Date.now() }); },
        (error: unknown) => { if (!controller.signal.aborted) dispatch({ type: "failure", key, error }); },
      );
    };
    runRef.current = run;
    run(false);
    const timer = intervalMs
      ? setInterval(() => { if (!document.hidden) run(true); }, intervalMs)
      : undefined;
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [key, enabled, intervalMs]);

  const refresh = useCallback(() => runRef.current(true), []);
  // Derived, not stored: when the key changes before the first answer, show a clean loading state.
  const state: QueryState<T> = raw.key === key ? raw : initialQueryState<T>(key);

  return {
    data: state.data,
    error: state.error,
    loading: enabled && state.status === "loading",
    updating: state.status === "updating",
    connection: connectionOf(state),
    updatedAt: state.updatedAt,
    refresh,
  };
}
