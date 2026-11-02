"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { backoffMs } from "./backoff.ts";
import { connectionOf, initialQueryState, queryReducer, type QueryState } from "./queryState.ts";
import type { Connection } from "./freshness.ts";

export type DeskQueryOptions = {
  /** Refetch every this many ms while the tab is visible; old values stay on screen meanwhile. After a failed read the wait doubles per failure (up to a minute). */
  intervalMs?: number;
  /** Skip fetching (for example until a symbol is known). */
  enabled?: boolean;
  /** Bump to refetch now while keeping the old values on screen (another screen changed the data). */
  revision?: number;
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
  /** Failed reads in a row since the last answer (0 when the last read worked). */
  failures: number;
  refresh: () => void;
};

/**
 * Fetch state plus an interval refetch that keeps old values on screen (02m §c4). `key` identifies
 * the request (symbol, timeframe, filter id): a new key starts from "loading" without the old data.
 */
export function useDeskQuery<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  { intervalMs, enabled = true, revision = 0 }: DeskQueryOptions = {},
): DeskQueryResult<T> {
  const [raw, dispatch] = useReducer(queryReducer<T>, key, initialQueryState<T>);
  const fetcherRef = useRef(fetcher);
  const runRef = useRef<(background: boolean) => void>(() => undefined);
  // The interval tick below reads these: when the last read failed, it waits out the backoff before asking again.
  const failuresRef = useRef(0);
  const failedAtRef = useRef(0);

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
        (error: unknown) => {
          if (controller.signal.aborted) return;
          failedAtRef.current = Date.now();
          dispatch({ type: "failure", key, error });
        },
      );
    };
    runRef.current = run;
    run(false);
    const timer = intervalMs
      ? setInterval(() => {
          if (document.hidden) return;
          if (failuresRef.current > 0 && Date.now() - failedAtRef.current < backoffMs(intervalMs, failuresRef.current)) return;
          run(true);
        }, intervalMs)
      : undefined;
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [key, enabled, intervalMs, revision]);

  const refresh = useCallback(() => runRef.current(true), []);
  // Derived, not stored: when the key changes before the first answer, show a clean loading state.
  const state: QueryState<T> = raw.key === key ? raw : initialQueryState<T>(key);
  useEffect(() => {
    failuresRef.current = state.failures;
  });

  return {
    data: state.data,
    error: state.error,
    loading: enabled && state.status === "loading",
    updating: state.status === "updating",
    connection: connectionOf(state),
    updatedAt: state.updatedAt,
    failures: state.failures,
    refresh,
  };
}
