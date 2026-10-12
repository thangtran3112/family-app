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
// current generation) whenever a mutation is pending; `isCurrent()` is the
// one check both a settling read and a settling mutation use to decide
// whether to apply/reschedule; `endMutation()` always runs (success or
// failure) so a new read can begin again afterward.
//
// Fix-round-3 review found `beginMutation()` itself was not exclusive: it
// always started a *second* mutation even while one was still pending,
// taking a newer ticket than the first's -- so the first mutation's own
// `finally` then unconditionally cleared the single `mutating` flag while
// the second PUT was still in flight, reopening reads (and discarding the
// second mutation's eventual snapshot the same way round 2 fixed for
// reads-during-a-single-mutation). `beginMutation()` now refuses outright
// (returns null, no ticket taken, no effect on the generation) whenever a
// mutation is already pending; the caller (`createControlsController`
// below) must reject the second `change()` before ever issuing its PUT,
// not merely rely on the Settings UI disabling its buttons.
export type ReadAttempt = { ticket: number };

export type ControlsScheduler = {
  attemptRead(): ReadAttempt | null;
  beginMutation(): number | null;
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
    beginMutation(): number | null {
      if (mutating) return null;
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

// --- Controller: the actual async poll/mutation lifecycle ------------------
//
// Fix-round-3 review: round 2's tests exercised the pure scheduler/outcome
// helpers directly (e.g. calling `scheduler.attemptRead()` in place of a
// "focus" event), not the real async flow the React provider runs --
// `change()`'s PUT resolved synchronously in those tests, so they could not
// actually prove a concurrently-attempted read's fetch was suppressed, or
// that a real aborted in-flight GET leaves a mutation's own 2s reschedule
// alone. `createControlsController` is the fix: it *is* the production
// load/change/cycle/schedule logic (fetch calls, AbortController, setTimeout,
// the scheduler, deciding what to apply) extracted out of the "use client"
// React component into one plain, framework-free function, injectable with a
// fake `fetchImpl` and fake timer functions for deterministic, real-async
// (real Promises, real microtask ordering, real AbortSignal propagation)
// tests with no new test framework or dependency -- the same "hand-rolled
// fake boundary, no mocking framework" style already used in lib/auth.test.ts.
// `components/app-controls-provider.tsx` constructs exactly one of these per
// authenticated session and wires its callbacks to React state; it contains
// no parallel reimplementation of this logic.
export type ControlsControllerDeps = {
  getToken: () => Promise<string | null>;
  onState: (state: ControlsState) => void;
  onLoading: (loading: boolean) => void;
  onError: (error: string | null) => void;
  onMutating: (mutating: boolean) => void;
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: (callback: () => void, delayMs: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
};

export type ControlsController = {
  // Starts the initial read and the recurring poll; safe to call once per
  // controller instance (one per authenticated session in the provider).
  start(): void;
  // Stops polling, aborts any in-flight request, and makes every pending or
  // future callback from this instance a no-op -- the controller-level
  // analogue of the old `sessionIdRef` check, scoped to one instance instead
  // of compared against a ref.
  stop(): void;
  // An explicit, on-demand read (the Settings panel's Refresh button).
  load(): Promise<ReadOutcome>;
  change(id: AppId, enabled: boolean): Promise<void>;
  // Called by the provider's `window` focus listener (kept out of this
  // DOM-free module on purpose).
  handleFocus(): void;
};

export function createControlsController(deps: ControlsControllerDeps): ControlsController {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setTimeoutImpl = deps.setTimeoutImpl ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const scheduler = createControlsScheduler();
  let abortController: AbortController | null = null;
  let timer: unknown = null;
  let stopped = false;
  let latestState: ControlsState | null = null;

  function scheduleAt(delayMs: number): void {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = setTimeoutImpl(() => void cycle(), delayMs);
  }
  // An *intentional* reschedule (a mutation's own settled outcome) always
  // schedules -- unlike `cycle()`'s own use of `pollDelayAfter`, which must
  // not for a "stale" read.
  function scheduleFrom(result: ControlsState | null): void {
    scheduleAt(nextPollDelayMs(result));
  }

  async function load(): Promise<ReadOutcome> {
    const attempt = scheduler.attemptRead();
    if (!attempt) return { kind: "stale" }; // a mutation is pending; this read never started
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    deps.onLoading(true);
    try {
      const next = await fetchApps(deps.getToken, fetchImpl, controller.signal);
      if (stopped || !scheduler.isCurrent(attempt.ticket)) return { kind: "stale" };
      latestState = next;
      deps.onState(next);
      deps.onError(null);
      deps.onLoading(false);
      return { kind: "applied", state: next };
    } catch (err) {
      if (stopped || isAbortError(err) || !scheduler.isCurrent(attempt.ticket)) return { kind: "stale" };
      deps.onError(err instanceof Error ? err.message : "App controls are unavailable.");
      deps.onLoading(false);
      return { kind: "failed" };
    }
  }

  async function cycle(): Promise<void> {
    if (stopped) return;
    const outcome = await load();
    if (stopped) return;
    const delay = pollDelayAfter(outcome);
    if (delay === null) return; // stale: a newer read or a mutation already owns scheduling
    scheduleAt(delay);
  }

  async function change(id: AppId, enabled: boolean): Promise<void> {
    const current = latestState;
    if (!current) throw new ControlsError("App controls are not loaded yet.");
    // Mutation exclusivity (fix-round-3 review): refuse a second mutation
    // outright, before ever aborting a read or sending a second PUT, rather
    // than relying on the Settings UI disabling its buttons.
    const ticket = scheduler.beginMutation();
    if (ticket === null) throw new ControlsError("Another app change is already in progress. Please wait for it to finish.");
    abortController?.abort();
    deps.onMutating(true);
    let applied: ControlsState | null = null;
    try {
      const next = await changeApp(id, enabled, current.revision, deps.getToken, fetchImpl);
      if (stopped || !scheduler.isCurrent(ticket)) return;
      latestState = next;
      deps.onState(next);
      deps.onError(null);
      applied = next;
    } finally {
      // Local lease release always runs, stopped or not -- it only affects
      // this controller instance's own (otherwise-dead) scheduler, never a
      // successor's.
      scheduler.endMutation();
      // Re-review-3 Important #1: a stopped controller's late-settling PUT
      // must never write into a *callback* -- `onMutating`, like `onState`/
      // `onError`/`onLoading` elsewhere in this module, is wired to the same
      // React setter across controller instances in app-controls-provider.tsx
      // (one instance per Clerk session, same component). An unconditional
      // `deps.onMutating(false)` here could fire after a session switch,
      // clearing a successor controller's own real in-flight mutation's busy
      // flag.
      if (!stopped) {
        deps.onMutating(false);
        // Reschedule from this mutation's own outcome (the fresh snapshot on
        // success, or the pre-mutation state as the best-known fallback on
        // failure) so background polling always has an active timer once
        // this mutation stops blocking new reads -- whether or not a
        // focus/timer attempt was refused while it was pending.
        if (scheduler.isCurrent(ticket)) scheduleFrom(applied ?? current);
      }
    }
  }

  return {
    start(): void {
      void cycle();
    },
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeoutImpl(timer);
      abortController?.abort();
    },
    load,
    change,
    handleFocus(): void {
      if (stopped) return;
      if (timer !== null) {
        clearTimeoutImpl(timer);
        timer = null;
      }
      void cycle();
    },
  };
}
