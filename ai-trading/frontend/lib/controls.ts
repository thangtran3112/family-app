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

// Mirrors control/state.py's `_is_utc_timestamp`: the server always
// *produces* seconds-precision "...Z" (`_utc_now`), but the field is
// validated more broadly as any ISO-8601 instant whose offset is exactly
// UTC -- "Z" or a literal "+00:00"/"-00:00" -- never a non-zero offset.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]00:00)$/;
function isNullableUtcTimestamp(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === "string" && UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

// Mirrors control/state.py's `_require_uuid4`: canonical lowercase
// 8-4-4-4-12 form only, version nibble "4", variant nibble one of 8/9/a/b --
// not merely "parses as some UUID" (Python's check also fails a
// differently-cased or non-canonical-but-equivalent string).
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function isNullableUuid4(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID_V4.test(value));
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
  if (!isNullableUtcTimestamp(v.changedAt)) throw new ControlsError("App controls returned an invalid change timestamp.");
  if (!isNullableUuid4(v.operationId)) throw new ControlsError("App controls returned an invalid operation ID.");
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
  if (!isNullableUtcTimestamp(v.lastChangedAt)) throw new ControlsError("App controls returned an invalid change timestamp.");
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
// message (matched by `isRefreshableConflict`) rather than silently
// overwritten.
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

// Settings panel rows: text status always comes straight from `app.status`
// (STATUS_TEXT in app-controls-panel.tsx), never from this -- there is
// nothing left here to compute. Launch surfaces use `appLaunchGate` below.

// --- Launch availability -------------------------------------------------
//
// Fix-round-1 critical finding: the previous `isAppKnownStopped` was
// `!(enabled && status === "Running")`, which labelled Starting, Stopping,
// Needs setup, Unhealthy, and Error all as "stopped", and would also call a
// literally-Running app "off" purely because its desired flag was false.
// `status` is the server's live-computed truth (control/runtime.py's
// `group_status` only ever returns "Running" when the group is actually up
// and healthy); `enabled` is desired intent, never proof of reachability.
// "Stopped" wording is used only when `status === "Stopped"`; every other
// non-Running status gets its own truthful, status-specific blocked message
// (`launchBlockedCopy`) -- none of them claim the app is reachable, and none
// of them claim it is specifically "stopped" unless it actually is.
export type LaunchGate = { kind: "unknown" } | { kind: "available" } | { kind: "blocked"; status: Exclude<AppStatus, "Running"> };

export function appLaunchGate(state: ControlsState | null, id: string): LaunchGate {
  const entry = state?.apps.find((app) => app.id === id);
  // Unknown (no snapshot yet, or this id is missing from it) defaults to the
  // same presentation as "available": never guess Stopped while uncertain,
  // exactly as never guessing Running while uncertain. This is also what
  // keeps static export (no live session) showing real destinations/props
  // via the normal launch branch instead of a fabricated "off" state.
  if (!entry) return { kind: "unknown" };
  if (entry.status === "Running") return { kind: "available" };
  return { kind: "blocked", status: entry.status };
}

export function launchBlockedCopy(status: Exclude<AppStatus, "Running">): { headline: string; detail: string } {
  switch (status) {
    case "Stopped":
      return { headline: "is turned off right now.", detail: "Turn it back on in Settings. Your existing data stays put." };
    case "Starting":
      return { headline: "is starting up.", detail: "This can take a moment. Check Settings for the latest status." };
    case "Stopping":
      return { headline: "is stopping.", detail: "This can take a moment. Check Settings for the latest status." };
    case "Needs setup":
      return { headline: "needs setup before it can run.", detail: "See Settings for what's needed." };
    case "Unhealthy":
      return { headline: "isn't responding as expected right now.", detail: "Check Settings for the latest status." };
    case "Error":
      return { headline: "ran into a problem.", detail: "See Settings to retry." };
  }
}

// --- Settings panel decisions ---------------------------------------------

// A failed operation's Retry always reconciles the stored desired choice --
// never an opposite toggle.
export function retryDesiredEnabled(app: AppState): boolean {
  return app.enabled;
}

// A retry of a desired-Off app must repeat the same Stop confirmation a
// fresh stop request would require: a failed stop may have left work
// running, so the interruption warning still applies.
export function retryRequiresStopConfirmation(app: AppState): boolean {
  return !app.enabled;
}

// Matches changeApp's fixed 409 message above; kept as a named predicate
// (not an inline regex at the call site) so the one place that decides
// "this failure means refresh, don't just show it" is a single, tested unit.
export function isRefreshableConflict(message: string): boolean {
  return /changed|refresh/i.test(message);
}

// --- Polling cadence -------------------------------------------------------

export const IDLE_POLL_MS = 30_000;
export const ACTIVE_POLL_MS = 2_000;

// Fix-round-1 important finding: the provider used to compute this from
// `stateRef.current` *before* issuing a fetch, then never recomputed it once
// that fetch actually settled -- so a transition snapshot never sped up the
// outstanding timer, and the return to idle never slowed it back down. The
// provider now calls this with the just-settled result (or null) after
// every read, so the next delay always reflects the latest known state.
export function nextPollDelayMs(state: ControlsState | null): number {
  const transitioning = !!state?.apps.some((app) => app.status === "Starting" || app.status === "Stopping");
  return transitioning ? ACTIVE_POLL_MS : IDLE_POLL_MS;
}

// --- Response ordering -----------------------------------------------------
//
// Fix-round-1 important finding: a GET in flight when a PUT is issued could
// resolve after the PUT and overwrite its result, because only *prior reads*
// were aborted (never a pending read racing a new mutation) and session
// matching alone doesn't order two already-dispatched requests. Revision
// can't gate this either: a completed operation doesn't bump revision by
// itself (reconciliation does, asynchronously) -- two different async calls
// can legitimately resolve carrying the *same* revision.
//
// `createGenerationGate` is a tiny sequence number: every read or mutation
// calls `begin()` synchronously, before its own `await`, and only applies
// its result if `accepts()` still says it's the most recently begun attempt
// by the time it resolves. A newer attempt (another read OR a mutation)
// immediately supersedes every earlier one, regardless of arrival order or
// revision. The provider is the one production caller of this -- it is not
// reimplemented there as a parallel/untested copy.
export type GenerationGate = { begin(): number; accepts(ticket: number): boolean };

export function createGenerationGate(): GenerationGate {
  let current = 0;
  return {
    begin(): number {
      current += 1;
      return current;
    },
    accepts(ticket: number): boolean {
      return ticket === current;
    },
  };
}
