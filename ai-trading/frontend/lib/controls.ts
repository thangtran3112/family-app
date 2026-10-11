// Exact public DTO from the app-controls design (common-context.md /
// 01g-hub-service-controls-design.md). GET/PUT `/__control/apps[/id]` always
// return this full four-app snapshot; the helper's internal state (desired
// map, operation, Docker/host details) never reaches the browser.
export type AppId = "tradingagents" | "ai-hedge-fund" | "vibe-trading" | "mirofish";
export type AppStatus = "Running" | "Starting" | "Stopping" | "Stopped" | "Needs setup" | "Unhealthy" | "Error";
export type ErrorCode =
  | "needs_setup"
  | "image_missing"
  | "runtime_unavailable"
  | "operation_failed"
  | "operation_timeout"
  | "interrupted";
export type AppState = {
  id: AppId;
  enabled: boolean;
  status: AppStatus;
  changedAt: string | null;
  operationId: string | null;
  errorCode: ErrorCode | null;
};
export type ControlsState = {
  revision: number;
  lastChangedAt: string | null;
  apps: AppState[];
};

export const APP_IDS: readonly AppId[] = ["tradingagents", "ai-hedge-fund", "vibe-trading", "mirofish"];
const STATUSES = new Set<AppStatus>(["Running", "Starting", "Stopping", "Stopped", "Needs setup", "Unhealthy", "Error"]);
const ERROR_CODES = new Set<ErrorCode>([
  "needs_setup",
  "image_missing",
  "runtime_unavailable",
  "operation_failed",
  "operation_timeout",
  "interrupted",
]);

export class ControlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlsError";
  }
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseAppState(value: unknown): AppState {
  if (typeof value !== "object" || value === null) throw new ControlsError("App controls returned an unexpected app entry.");
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !APP_IDS.includes(v.id as AppId)) {
    throw new ControlsError("App controls returned an unknown app.");
  }
  if (typeof v.enabled !== "boolean") throw new ControlsError("App controls returned an invalid app state.");
  if (typeof v.status !== "string" || !STATUSES.has(v.status as AppStatus)) {
    throw new ControlsError("App controls returned an unknown status.");
  }
  if (!isNullableString(v.changedAt) || !isNullableString(v.operationId)) {
    throw new ControlsError("App controls returned an invalid app state.");
  }
  if (v.errorCode !== null && (typeof v.errorCode !== "string" || !ERROR_CODES.has(v.errorCode as ErrorCode))) {
    throw new ControlsError("App controls returned an unknown error code.");
  }
  return {
    id: v.id as AppId,
    enabled: v.enabled,
    status: v.status as AppStatus,
    changedAt: v.changedAt as string | null,
    operationId: v.operationId as string | null,
    errorCode: v.errorCode as ErrorCode | null,
  };
}

function parseControlsState(value: unknown): ControlsState {
  if (typeof value !== "object" || value === null) throw new ControlsError("App controls returned an unexpected response.");
  const v = value as Record<string, unknown>;
  if (typeof v.revision !== "number" || !Number.isInteger(v.revision) || v.revision < 0) {
    throw new ControlsError("App controls returned an invalid revision.");
  }
  if (!isNullableString(v.lastChangedAt)) throw new ControlsError("App controls returned an unexpected response.");
  if (!Array.isArray(v.apps)) throw new ControlsError("App controls returned an unexpected response.");
  const apps = v.apps.map(parseAppState);
  const seen = new Set<AppId>();
  for (const app of apps) {
    if (seen.has(app.id)) throw new ControlsError("App controls returned a duplicate app.");
    seen.add(app.id);
  }
  if (seen.size !== APP_IDS.length) throw new ControlsError("App controls did not return all four apps.");
  return { revision: v.revision, lastChangedAt: v.lastChangedAt as string | null, apps };
}

async function parseJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ControlsError("App controls returned an unexpected response.");
  }
}

function errorForStatus(status: number): ControlsError {
  if (status === 401 || status === 403) return new ControlsError("Your session has expired. Please sign in again.");
  if (status === 503) return new ControlsError("App controls are temporarily unavailable. Try again shortly.");
  return new ControlsError(`App controls returned an unexpected response (status ${status}).`);
}

async function authHeaders(getToken: () => Promise<string | null>): Promise<HeadersInit> {
  let token: string | null;
  try {
    token = await getToken();
  } catch {
    token = null;
  }
  if (!token) throw new ControlsError("Please sign in to manage app controls.");
  return { Authorization: `Bearer ${token}` };
}

async function runFetch(fetchImpl: typeof fetch, input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ControlsError("Could not reach app controls. Check your connection and try again.");
  }
}

// GET /__control/apps: only 200 is a valid snapshot. The optional `signal`
// lets a caller (the polling provider) cancel a stale in-flight read.
export async function fetchApps(
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ControlsState> {
  const headers = await authHeaders(getToken);
  const res = await runFetch(fetchImpl, "/__control/apps", { method: "GET", headers, signal });
  if (res.status !== 200) throw errorForStatus(res.status);
  return parseControlsState(await parseJsonBody(res));
}

// PUT /__control/apps/{id}: only {enabled, expectedRevision} is ever sent --
// never an actor id or command. 200/202 both return the full snapshot; a
// stale/conflicting revision is 409, surfaced as a refresh-and-explain
// message rather than silently overwritten.
export async function changeApp(
  id: AppId,
  enabled: boolean,
  expectedRevision: number,
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ControlsState> {
  const headers = await authHeaders(getToken);
  const res = await runFetch(fetchImpl, `/__control/apps/${id}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, expectedRevision }),
    signal,
  });
  if (res.status === 409) {
    throw new ControlsError("Someone else already changed this app. Refresh to see the latest state.");
  }
  if (res.status !== 200 && res.status !== 202) throw errorForStatus(res.status);
  return parseControlsState(await parseJsonBody(res));
}

// Settings rows never claim an app is reachable unless both the desired flag
// and the actual status agree -- loading, missing, or any other status is
// treated as not running, never optimistically "Running".
export function isAppConfirmedRunning(state: ControlsState | null, id: string): boolean {
  const entry = state?.apps.find((app) => app.id === id);
  return !!entry && entry.enabled && entry.status === "Running";
}

// Launch surfaces (cards, terminal/external detail) use this instead: true
// only once the snapshot has loaded and positively confirms the app is not
// running, so they default to their normal launch CTA while state is still
// unknown rather than guessing "stopped" -- the opposite failure mode from
// isAppConfirmedRunning, and just as important: an unknown app must never
// be presented as definitely off, either.
export function isAppKnownStopped(state: ControlsState | null, id: string): boolean {
  const entry = state?.apps.find((app) => app.id === id);
  return !!entry && !(entry.enabled && entry.status === "Running");
}
