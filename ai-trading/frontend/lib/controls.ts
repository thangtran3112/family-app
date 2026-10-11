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
  // "unknown" (no snapshot yet, this id is missing, or a refresh failed --
  // callers pass `error ? null : state`) never claims Running *or* Stopped;
  // `launchGuidance` below gives it its own distinct, non-launching copy
  // (fix-round-2 review: it must not be rendered the same as "available").
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

// Fix-round-2 review (Important #3): "unknown" was rendered identically to
// "available" -- for a terminal app that meant mounting the live iframe and
// full-screen/Research actions while nothing had confirmed it was actually
// reachable, which is not guidance at all and is indistinguishable from
// confirmed availability. `launchGuidance` gives "unknown" (no snapshot yet,
// or a failed refresh -- see appLaunchGate) its own distinct copy that never
// claims Running or Stopped, with a Refresh affordance callers should wire
// to `useAppControls().refresh`; `available` returns null so callers render
// their normal launch UI only once status is actually confirmed Running.
export type LaunchGuidance = { headline: string; detail: string; showRefresh: boolean };

export function launchGuidance(gate: LaunchGate): LaunchGuidance | null {
  if (gate.kind === "available") return null;
  if (gate.kind === "unknown") {
    return {
      headline: "status can't be confirmed right now.",
      detail: "Check your connection and try Refresh, or open Settings.",
      showRefresh: true,
    };
  }
  return { ...launchBlockedCopy(gate.status), showRefresh: false };
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

// --- Response ordering & mutation exclusivity ------------------------------
//
// Fix-round-1 found a GET in flight when a PUT is issued could resolve after
// the PUT and overwrite it -- fixed with a plain monotonic ticket ("most
// recently begun wins"), since revision can't gate this (a completed
// operation doesn't bump it by itself; two different calls can legitimately
// settle with the same revision).
//
// Fix-round-2 review found the plain ticket was not enough: a focus/timer
// read could still *begin* while a PUT was pending, take a newer ticket than
// the PUT's, and so make the PUT's own successful snapshot fail its ticket
// check and get discarded once it settled -- "most recently begun wins" is
// not the same guarantee as "a pending mutation's result survives". A read
// must never even be allowed to start while a mutation is in flight, not
// merely lose a race against one.
//
// `createControlsScheduler` is what the provider actually calls for every
// decision (it is not reimplemented there as a parallel/untested copy):
// `attemptRead()` returns null outright (no ticket taken, no effect on the
// current generation) whenever a mutation is pending; `beginMutation()` is
// never refused and always takes a newer ticket than anything in flight;
// `isCurrent()` is the one check both a settling read and a settling
// mutation use to decide whether to apply/reschedule; `endMutation()` always
// runs (success or failure) so a new read can begin again afterward.
export type ReadAttempt = { ticket: number };

export type ControlsScheduler = {
  attemptRead(): ReadAttempt | null;
  beginMutation(): number;
  isCurrent(ticket: number): boolean;
  endMutation(): void;
};

export function createControlsScheduler(): ControlsScheduler {
  let generation = 0;
  let mutating = false;
  return {
    attemptRead(): ReadAttempt | null {
      if (mutating) return null;
      generation += 1;
      return { ticket: generation };
    },
    beginMutation(): number {
      mutating = true;
      generation += 1;
      return generation;
    },
    isCurrent(ticket: number): boolean {
      return ticket === generation;
    },
    endMutation(): void {
      mutating = false;
    },
  };
}

// --- Polling cycle outcomes --------------------------------------------------
//
// Fix-round-2 review: an already-in-flight read that gets invalidated
// (aborted by a new mutation, or superseded by a newer read) still resolved
// to a bare `null` and the polling loop rescheduled anyway at the 30s idle
// cadence -- capable of silently replacing a mutation's own just-set 2s
// transition timer. `"stale"` is a distinct outcome from `"failed"`
// (a genuine fetch error) specifically so the polling loop can tell "this
// attempt was invalidated, some newer attempt already owns scheduling" apart
// from "this attempt genuinely failed, schedule the idle cadence" -- and
// never reschedule for the former.
export type ReadOutcome = { kind: "applied"; state: ControlsState } | { kind: "failed" } | { kind: "stale" };

export function pollDelayAfter(outcome: ReadOutcome): number | null {
  if (outcome.kind === "stale") return null;
  return nextPollDelayMs(outcome.kind === "applied" ? outcome.state : null);
}
