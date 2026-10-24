import type { Connection } from "./freshness.ts";

// State machine behind `useDeskQuery` (02m §c4). Kept pure so a node test can walk every transition.
export type QueryStatus = "loading" | "ready" | "updating" | "error";
export type QueryState<T> = {
  key: string;
  data: T | null;
  error: unknown;
  status: QueryStatus;
  updatedAt: number | null;
};
export type QueryAction<T> =
  | { type: "start"; key: string }
  | { type: "success"; key: string; data: T; at: number }
  | { type: "failure"; key: string; error: unknown };

export function initialQueryState<T>(key: string): QueryState<T> {
  return { key, data: null, error: null, status: "loading", updatedAt: null };
}

export function queryReducer<T>(state: QueryState<T>, action: QueryAction<T>): QueryState<T> {
  // A different key means the caller moved on (new symbol or timeframe): drop the old data.
  const base = action.key === state.key ? state : initialQueryState<T>(action.key);
  switch (action.type) {
    case "start":
      return base.data === null ? { ...base, status: "loading", error: null } : { ...base, status: "updating" };
    case "success":
      return { key: action.key, data: action.data, error: null, status: "ready", updatedAt: action.at };
    case "failure":
      // A failed refresh keeps the old values on screen; only a first load becomes an error screen.
      return base.data === null ? { ...base, status: "error", error: action.error } : { ...base, status: "ready", error: action.error };
  }
}

/** The state of the live connection for `FreshnessBadge`: refreshing, or failing while old values stay. */
export function connectionOf(state: Pick<QueryState<unknown>, "status" | "data" | "error">): Connection {
  if (state.status === "updating") return "updating";
  if (state.data !== null && state.error !== null) return "reconnecting";
  return "ok";
}
