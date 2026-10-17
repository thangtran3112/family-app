import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_POLL_MS,
  appLaunchGate,
  changeApp,
  createControlsController,
  createControlsScheduler,
  fetchApps,
  IDLE_POLL_MS,
  isRefreshableConflict,
  launchBlockedCopy,
  launchGuidance,
  nextPollDelayMs,
  pollDelayAfter,
  retryDesiredEnabled,
  retryRequiresStopConfirmation,
  type AppId,
  type AppState,
  type ControlsState,
} from "./controls.ts";

// Hand-checked fixture matching the exact public DTO from common-context.md:
// {revision, lastChangedAt, apps: [{id, enabled, status, changedAt, operationId, errorCode}]}.
function controlsFixture(revision = 0): ControlsState {
  return {
    revision,
    lastChangedAt: null,
    apps: (["tradingagents", "ai-hedge-fund", "vibe-trading", "mirofish"] as AppId[]).map((id) => ({
      id,
      enabled: id !== "mirofish",
      status: id === "mirofish" ? "Stopped" : "Running",
      changedAt: null,
      operationId: null,
      errorCode: null,
    })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("mutation sends bearer, revision and boolean, never actor/command", async () => {
  let call: { url: string; init: RequestInit } | undefined;
  await changeApp("mirofish", false, 7, async () => "fixture-token", async (url, init) => {
    call = { url: String(url), init: init! };
    const state = controlsFixture(8);
    Object.assign(state.apps[3], { status: "Stopping", operationId: "00000000-0000-4000-8000-000000000000" });
    return new Response(JSON.stringify(state), { status: 202 });
  });
  assert.equal(call!.url, "/__control/apps/mirofish");
  assert.equal(new Headers(call!.init.headers).get("authorization"), "Bearer fixture-token");
  assert.deepEqual(JSON.parse(String(call!.init.body)), { enabled: false, expectedRevision: 7 });
});

test("missing token makes no request and stale state is explicit", async () => {
  let called = false;
  await assert.rejects(changeApp("mirofish", true, 0, async () => null,
    async () => { called = true; return new Response(); }), /sign in/i);
  assert.equal(called, false);
  await assert.rejects(changeApp("mirofish", true, 0, async () => "fixture",
    async () => new Response("{}", { status: 409 })), /changed|refresh/i);
});

test("changeApp accepts 200 in addition to 202 and rejects 204 as invalid", async () => {
  const ok = await changeApp("mirofish", true, 0, async () => "tok", async () => jsonResponse(controlsFixture(1), 200));
  assert.equal(ok.revision, 1);
  await assert.rejects(changeApp("mirofish", true, 0, async () => "tok", async () => new Response(null, { status: 204 })));
});

test("changeApp rejects unsupported response codes (401, 403, 503, 500)", async () => {
  for (const status of [401, 403, 503, 500]) {
    await assert.rejects(changeApp("mirofish", true, 0, async () => "tok", async () => new Response("{}", { status })));
  }
});

test("fetchApps sends the bearer token and returns the validated snapshot on 200", async () => {
  let call: { url: string; init: RequestInit } | undefined;
  const result = await fetchApps(async () => "tok-abc", async (url, init) => {
    call = { url: String(url), init: init! };
    return jsonResponse(controlsFixture(3), 200);
  });
  assert.equal(call!.url, "/__control/apps");
  assert.equal(call!.init.method, "GET");
  assert.equal(new Headers(call!.init.headers).get("authorization"), "Bearer tok-abc");
  assert.equal(result.revision, 3);
  assert.equal(result.apps.length, 4);
});

test("fetchApps makes no request and rejects when no token is available", async () => {
  let called = false;
  await assert.rejects(
    fetchApps(async () => null, async () => { called = true; return jsonResponse(controlsFixture()); }),
    /sign in/i,
  );
  assert.equal(called, false);
});

test("fetchApps accepts 200 only; 202 and other statuses are rejected", async () => {
  await assert.rejects(fetchApps(async () => "tok", async () => jsonResponse(controlsFixture(), 202)));
  for (const status of [401, 403, 503, 500]) {
    await assert.rejects(fetchApps(async () => "tok", async () => new Response("{}", { status })));
  }
});

test("fetchApps rejects invalid JSON", async () => {
  await assert.rejects(fetchApps(async () => "tok", async () => new Response("not json", { status: 200 })));
});

test("fetchApps rejects when the network call itself fails", async () => {
  await assert.rejects(fetchApps(async () => "tok", async () => { throw new Error("network down"); }));
});

test("an aborted call rejects with the underlying abort error, unwrapped", async () => {
  const abortErr = new DOMException("The operation was aborted.", "AbortError");
  await assert.rejects(
    fetchApps(async () => "tok", async () => { throw abortErr; }, new AbortController().signal),
    (err: unknown) => err === abortErr,
  );
});

test("fetchApps and changeApp forward the abort signal to the fetch implementation", async () => {
  const controller = new AbortController();
  let fetchAppsSignal: AbortSignal | null | undefined;
  await fetchApps(async () => "tok", async (_url, init) => {
    fetchAppsSignal = init?.signal;
    return jsonResponse(controlsFixture());
  }, controller.signal);
  assert.equal(fetchAppsSignal, controller.signal);

  let changeAppSignal: AbortSignal | null | undefined;
  await changeApp("mirofish", true, 0, async () => "tok", async (_url, init) => {
    changeAppSignal = init?.signal;
    return jsonResponse(controlsFixture(1), 202);
  }, controller.signal);
  assert.equal(changeAppSignal, controller.signal);
});

test("rejects a response with an unknown app id", async () => {
  const bad = controlsFixture();
  bad.apps[0] = { ...bad.apps[0], id: "unknown-app" as AppId };
  await assert.rejects(fetchApps(async () => "tok", async () => jsonResponse(bad)));
});

test("rejects a response with a duplicate app id", async () => {
  const bad = controlsFixture();
  bad.apps[1] = { ...bad.apps[1], id: bad.apps[0].id };
  await assert.rejects(fetchApps(async () => "tok", async () => jsonResponse(bad)));
});

test("rejects a response missing one of the four apps", async () => {
  const bad = controlsFixture();
  bad.apps.pop();
  await assert.rejects(fetchApps(async () => "tok", async () => jsonResponse(bad)));
});

test("rejects a response with an unknown status code", async () => {
  const bad = controlsFixture();
  bad.apps[0] = { ...bad.apps[0], status: "Paused" as never };
  await assert.rejects(fetchApps(async () => "tok", async () => jsonResponse(bad)));
});

test("rejects a response with an unknown error code", async () => {
  const bad = controlsFixture();
  bad.apps[0] = { ...bad.apps[0], status: "Error" as never, errorCode: "sabotage" as never };
  await assert.rejects(fetchApps(async () => "tok", async () => jsonResponse(bad)));
});

test("rejects a negative or boolean-like revision", async () => {
  const negative = controlsFixture();
  (negative as unknown as { revision: number }).revision = -1;
  await assert.rejects(fetchApps(async () => "tok", async () => jsonResponse(negative)));

  const boolRevision = controlsFixture();
  (boolRevision as unknown as { revision: unknown }).revision = true;
  await assert.rejects(fetchApps(async () => "tok", async () => jsonResponse(boolRevision)));
});

test("rejects an invalid lastChangedAt or changedAt timestamp", async () => {
  const badTop = controlsFixture();
  (badTop as unknown as { lastChangedAt: string }).lastChangedAt = "2026-01-01 00:00:00";
  await assert.rejects(fetchApps(async () => "tok", async () => jsonResponse(badTop)));

  const badApp = controlsFixture();
  badApp.apps[0] = { ...badApp.apps[0], changedAt: "2026-01-01T00:00:00+05:00" };
  await assert.rejects(fetchApps(async () => "tok", async () => jsonResponse(badApp)), /timestamp/i);
});

test("accepts both the server's Z form and an explicit +00:00/-00:00 UTC offset", async () => {
  for (const stamp of ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00.123-00:00"]) {
    const good = controlsFixture();
    good.lastChangedAt = stamp;
    good.apps[0] = { ...good.apps[0], changedAt: stamp };
    const result = await fetchApps(async () => "tok", async () => jsonResponse(good));
    assert.equal(result.lastChangedAt, stamp);
  }
});

test("rejects a malformed or non-canonical operationId", async () => {
  for (const bad of ["not-a-uuid", "00000000-0000-0000-8000-000000000000", "0000000a-0000-4000-8000-00000000000z", "0000000A-0000-4000-8000-00000000000B"]) {
    const state = controlsFixture();
    state.apps[0] = { ...state.apps[0], operationId: bad };
    await assert.rejects(fetchApps(async () => "tok", async () => jsonResponse(state)), /operation/i);
  }
});

test("accepts a canonical lowercase UUID4 operationId", async () => {
  const state = controlsFixture();
  state.apps[0] = { ...state.apps[0], operationId: "00000000-0000-4000-8000-000000000000" };
  const result = await fetchApps(async () => "tok", async () => jsonResponse(state));
  assert.equal(result.apps[0].operationId, "00000000-0000-4000-8000-000000000000");
});

test("appLaunchGate: Running is the only available status, regardless of the desired flag", () => {
  const state = controlsFixture();
  assert.deepEqual(appLaunchGate(state, "tradingagents"), { kind: "available" });
  // control/runtime.py's group_status never actually returns Running for a
  // desired-off app, but the client must not rely on that invariant either:
  // live `status` alone decides availability, never the cached `enabled` flag.
  const desiredOffButRunning = controlsFixture();
  desiredOffButRunning.apps[3] = { ...desiredOffButRunning.apps[3], enabled: false, status: "Running" };
  assert.deepEqual(appLaunchGate(desiredOffButRunning, "mirofish"), { kind: "available" });
});

test("appLaunchGate: every non-Running status is its own blocked status, never collapsed into Stopped", () => {
  const state = controlsFixture();
  for (const status of ["Starting", "Stopping", "Needs setup", "Unhealthy", "Error"] as const) {
    state.apps[3] = { ...state.apps[3], status };
    assert.deepEqual(appLaunchGate(state, "mirofish"), { kind: "blocked", status });
  }
  state.apps[3] = { ...state.apps[3], status: "Stopped" };
  assert.deepEqual(appLaunchGate(state, "mirofish"), { kind: "blocked", status: "Stopped" });
});

test("appLaunchGate is unknown (not blocked, not available) while unloaded or missing", () => {
  const state = controlsFixture();
  assert.deepEqual(appLaunchGate(null, "tradingagents"), { kind: "unknown" });
  assert.deepEqual(appLaunchGate(state, "not-a-real-app" as AppId), { kind: "unknown" });
});

test("launchBlockedCopy gives distinct, status-specific wording and never says 'off' for a non-Stopped status", () => {
  const seen = new Set<string>();
  for (const status of ["Stopped", "Starting", "Stopping", "Needs setup", "Unhealthy", "Error"] as const) {
    const copy = launchBlockedCopy(status);
    seen.add(copy.headline);
    if (status !== "Stopped") assert.doesNotMatch(copy.headline, /off|stopped/i);
  }
  assert.equal(seen.size, 6, "every status has distinct wording");
});

test("launchGuidance: available has no guidance; unknown is distinct from every blocked status and offers Refresh", () => {
  assert.equal(launchGuidance({ kind: "available" }), null);

  const unknown = launchGuidance({ kind: "unknown" })!;
  assert.equal(unknown.showRefresh, true);
  assert.doesNotMatch(unknown.headline, /running|stopped|off/i, "must not claim Running or Stopped while unconfirmed");

  for (const status of ["Stopped", "Starting", "Stopping", "Needs setup", "Unhealthy", "Error"] as const) {
    const blocked = launchGuidance({ kind: "blocked", status })!;
    assert.equal(blocked.showRefresh, false);
    assert.notEqual(blocked.headline, unknown.headline, `${status} guidance must not read the same as unknown`);
    assert.deepEqual({ headline: blocked.headline, detail: blocked.detail }, launchBlockedCopy(status));
  }
});

test("retry reconciles the stored desired choice and never flips it", () => {
  const on: AppState = { ...controlsFixture().apps[0], enabled: true };
  const off: AppState = { ...controlsFixture().apps[3], enabled: false };
  assert.equal(retryDesiredEnabled(on), true);
  assert.equal(retryDesiredEnabled(off), false);
});

test("retry of a desired-Off app requires the same Stop confirmation; desired-On does not", () => {
  const on: AppState = { ...controlsFixture().apps[0], enabled: true };
  const off: AppState = { ...controlsFixture().apps[3], enabled: false };
  assert.equal(retryRequiresStopConfirmation(on), false);
  assert.equal(retryRequiresStopConfirmation(off), true);
});

test("isRefreshableConflict matches the exact 409 message changeApp throws", () => {
  assert.equal(isRefreshableConflict("Someone else already changed this app. Refresh to see the latest state."), true);
  assert.equal(isRefreshableConflict("Your session has expired. Please sign in again."), false);
});

test("nextPollDelayMs is idle (30s) with no transition and active (2s) with any Starting/Stopping app", () => {
  const idle = controlsFixture();
  assert.equal(nextPollDelayMs(idle), IDLE_POLL_MS);
  assert.equal(nextPollDelayMs(null), IDLE_POLL_MS);

  const starting = controlsFixture();
  starting.apps[0] = { ...starting.apps[0], status: "Starting" };
  assert.equal(nextPollDelayMs(starting), ACTIVE_POLL_MS);

  const stopping = controlsFixture();
  stopping.apps[3] = { ...stopping.apps[3], status: "Stopping" };
  assert.equal(nextPollDelayMs(stopping), ACTIVE_POLL_MS);

  // transition -> idle: once the settled snapshot shows no app transitioning,
  // cadence returns to 30s even though an earlier call reported 2s.
  assert.equal(nextPollDelayMs(starting), ACTIVE_POLL_MS);
  assert.equal(nextPollDelayMs(idle), IDLE_POLL_MS);
});

test("scheduler: a read attempted while a mutation is pending is refused outright, not merely outraced", () => {
  // Fix-round-2 review Important #1: a plain ticket counter let a focus/
  // timer read *begin* during a pending PUT and take a newer ticket than
  // it, so the PUT's own successful snapshot later failed its ticket check.
  // attemptRead() must refuse outright -- no ticket taken at all -- so the
  // mutation's ticket stays current regardless of settle order.
  const s = createControlsScheduler();
  const mutationTicket = s.beginMutation()!;
  assert.equal(s.attemptRead(), null, "a read must not even start while a mutation is pending");
  assert.equal(s.isCurrent(mutationTicket), true, "the refused read attempt must not have touched the generation");
  s.endMutation();
  assert.notEqual(s.attemptRead(), null, "a new read is allowed once the mutation ends");
});

test("scheduler: a second mutation is refused outright while one is pending -- fix-round-3 Important #1", () => {
  // Round 2's beginMutation() always started a second mutation, even while
  // one was pending, taking a newer ticket than the first's -- the first
  // mutation's own endMutation() then unconditionally cleared the single
  // `mutating` flag while the second PUT was still in flight, reopening
  // reads. beginMutation() must refuse outright (no ticket, no generation
  // bump) the same way attemptRead() does.
  const s = createControlsScheduler();
  const firstTicket = s.beginMutation()!;
  assert.equal(s.beginMutation(), null, "a second mutation must be refused while the first is pending");
  assert.equal(s.isCurrent(firstTicket), true, "the refused second attempt must not have touched the generation");
  s.endMutation();
  assert.notEqual(s.beginMutation(), null, "a new mutation is allowed once the first ends");
});

test("scheduler: a read already in flight when a mutation begins is invalidated regardless of settle order", () => {
  for (const readSettlesFirst of [true, false]) {
    const s = createControlsScheduler();
    const readTicket = s.attemptRead()!.ticket;
    const mutationTicket = s.beginMutation()!;
    const order = readSettlesFirst ? [readTicket, mutationTicket] : [mutationTicket, readTicket];
    const results = order.map((t) => s.isCurrent(t));
    assert.equal(s.isCurrent(mutationTicket), true);
    assert.equal(s.isCurrent(readTicket), false);
    assert.ok(results.length === 2); // isCurrent is a pure query; checking order doesn't change the outcome
  }
});

test("scheduler: endMutation always clears the pending flag, success or failure, so reads resume", () => {
  const s = createControlsScheduler();
  s.beginMutation();
  s.endMutation(); // simulates the provider's `finally`, run even if changeApp threw
  assert.notEqual(s.attemptRead(), null);
});

test("pollDelayAfter: a stale outcome never reschedules; applied/failed do, via nextPollDelayMs", () => {
  assert.equal(pollDelayAfter({ kind: "stale" }), null);
  assert.equal(pollDelayAfter({ kind: "failed" }), IDLE_POLL_MS);
  assert.equal(pollDelayAfter({ kind: "applied", state: controlsFixture() }), IDLE_POLL_MS);

  const transitioning = controlsFixture();
  transitioning.apps[0] = { ...transitioning.apps[0], status: "Starting" };
  assert.equal(pollDelayAfter({ kind: "applied", state: transitioning }), ACTIVE_POLL_MS);
});

// --- createControlsController: real async flow, not isolated helpers -------
//
// Fix-round-3 review: round 2's "integration" tests resolved changeApp
// immediately and called `scheduler.attemptRead()` directly in place of a
// focus/timer event -- they proved the pure scheduler/outcome helpers
// compose correctly, not that the actual production controller suppresses a
// real fetch, preserves a mutation's snapshot, or leaves a real scheduled
// timer at 2s. These tests drive `createControlsController` -- the exact
// function `app-controls-provider.tsx` constructs and delegates every
// decision to -- with real deferred Promises and a hand-rolled fake clock
// (no mocking framework, no new dependency; same style as lib/auth.test.ts's
// fakeFetch), covering both settlement orders explicitly.

// A fake timer: setTimeout/clearTimeout stand-ins that record the scheduled
// delay instead of waiting on it, so tests can both inspect "what cadence
// would fire next" and manually fire it without a real wall-clock wait.
function createFakeClock() {
  let nextId = 0;
  const pending = new Map<number, { run: () => void; delayMs: number }>();
  return {
    setTimeoutImpl: (callback: () => void, delayMs: number): unknown => {
      const id = nextId++;
      pending.set(id, { run: callback, delayMs });
      return id;
    },
    clearTimeoutImpl: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    pendingDelay(): number | null {
      const [entry] = pending.values();
      return entry ? entry.delayMs : null;
    },
    pendingCount(): number {
      return pending.size;
    },
    fire(): void {
      const [[id, entry]] = pending.entries();
      pending.delete(id);
      entry.run();
    },
  };
}

// Spins the microtask queue until `predicate` holds (or `maxTicks` is spent),
// so a test can wait for an async chain it has no direct handle on (a
// fire-and-forget `cycle()`) to finish applying its result.
async function waitUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i++) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("controller: a focus-triggered read attempted while a mutation is pending never issues a GET, and the mutation's own snapshot is what applies", async () => {
  const clock = createFakeClock();
  const states: ControlsState[] = [];
  let getCalls = 0;
  let putCalls = 0;
  const putDeferred = deferred<Response>();

  const controller = createControlsController({
    getToken: async () => "tok",
    onState: (s) => states.push(s),
    onLoading: () => {},
    onError: () => {},
    onMutating: () => {},
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCalls += 1;
        return putDeferred.promise;
      }
      getCalls += 1;
      return jsonResponse(controlsFixture(0));
    }) as typeof fetch,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
  });

  controller.start();
  await waitUntil(() => states.length === 1);
  assert.equal(getCalls, 1, "the initial read happened once");

  const changePromise = controller.change("mirofish", true);
  controller.handleFocus(); // simulates a focus event firing while the PUT is pending
  await Promise.resolve();
  assert.equal(getCalls, 1, "a read attempted during a pending mutation must never issue a fetch");

  const starting = controlsFixture(1);
  starting.apps[3] = { ...starting.apps[3], status: "Starting" };
  putDeferred.resolve(jsonResponse(starting, 202));
  await changePromise;

  assert.equal(getCalls, 1, "still no extra read snuck in while the mutation was pending");
  assert.equal(putCalls, 1);
  assert.equal(states.at(-1)!.revision, 1, "the mutation's own snapshot is what applied");
  assert.equal(states.at(-1)!.apps[3].status, "Starting");
  assert.equal(clock.pendingDelay(), ACTIVE_POLL_MS, "the mutation's transition snapshot must schedule the 2s cadence");
});

test("controller: a GET already in flight when a mutation begins is dropped regardless of which settles first", async () => {
  for (const getSettlesFirst of [true, false]) {
    const clock = createFakeClock();
    const states: ControlsState[] = [];
    const getDeferred = deferred<Response>();
    const putDeferred = deferred<Response>();
    let getCalls = 0;

    const controller = createControlsController({
      getToken: async () => "tok",
      onState: (s) => states.push(s),
      onLoading: () => {},
      onError: () => {},
      onMutating: () => {},
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") return putDeferred.promise;
        getCalls += 1;
        return getCalls === 1 ? jsonResponse(controlsFixture(0)) : getDeferred.promise;
      }) as typeof fetch,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });

    controller.start();
    await waitUntil(() => states.length === 1); // initial read settles, populating latestState

    controller.handleFocus(); // a second read begins -- the one that will be caught in flight
    await waitUntil(() => getCalls === 2);

    const changePromise = controller.change("mirofish", true); // takes over while the read above is pending

    if (getSettlesFirst) {
      getDeferred.resolve(jsonResponse(controlsFixture(99))); // a wildly different, stale revision
      await Promise.resolve();
      await Promise.resolve();
    }
    putDeferred.resolve(jsonResponse(controlsFixture(1), 202));
    await changePromise;
    if (!getSettlesFirst) {
      getDeferred.resolve(jsonResponse(controlsFixture(99)));
      await Promise.resolve();
      await Promise.resolve();
    }

    assert.equal(states.at(-1)!.revision, 1, `the mutation's snapshot must win (GET settled ${getSettlesFirst ? "first" : "last"})`);
  }
});

test("controller: a second change() while one is pending is rejected before any second PUT request, and the first mutation's snapshot survives", async () => {
  const clock = createFakeClock();
  const states: ControlsState[] = [];
  let getCalls = 0;
  let putCalls = 0;
  const putDeferred = deferred<Response>();

  const controller = createControlsController({
    getToken: async () => "tok",
    onState: (s) => states.push(s),
    onLoading: () => {},
    onError: () => {},
    onMutating: () => {},
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCalls += 1;
        return putDeferred.promise;
      }
      getCalls += 1;
      return jsonResponse(controlsFixture(0));
    }) as typeof fetch,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
  });

  controller.start();
  await waitUntil(() => states.length === 1);

  const first = controller.change("mirofish", true);
  await assert.rejects(controller.change("tradingagents", false), /already in progress/i);
  assert.equal(putCalls, 1, "the second change() must never send a second PUT");

  controller.handleFocus(); // a read attempted while the (one) mutation is pending
  await Promise.resolve();
  assert.equal(getCalls, 1, "still only the initial read; the pending mutation blocks this one too");

  putDeferred.resolve(jsonResponse(controlsFixture(1), 202));
  await first;

  assert.equal(states.at(-1)!.revision, 1, "the first mutation's own snapshot must survive");
  assert.equal(putCalls, 1, "exactly one PUT was ever sent");
});

test("controller: a real in-flight read aborted by a mutation can never override the mutation's own 2s reschedule", async () => {
  const clock = createFakeClock();
  const states: ControlsState[] = [];
  const getDeferred = deferred<Response>();
  const putDeferred = deferred<Response>();
  let getCalls = 0;

  const controller = createControlsController({
    getToken: async () => "tok",
    onState: (s) => states.push(s),
    onLoading: () => {},
    onError: () => {},
    onMutating: () => {},
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return putDeferred.promise;
      getCalls += 1;
      if (getCalls === 1) return jsonResponse(controlsFixture(0));
      // The second read is the one that will actually be aborted: listen for
      // the real AbortSignal change() fires, exactly like the real fetch API.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        getDeferred.promise.then(() => reject(new Error("should have been aborted first")));
      });
    }) as typeof fetch,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
  });

  controller.start();
  await waitUntil(() => states.length === 1);

  controller.handleFocus(); // starts the read that change() below will abort
  await waitUntil(() => getCalls === 2);

  const starting = controlsFixture(1);
  starting.apps[3] = { ...starting.apps[3], status: "Starting" };
  const changePromise = controller.change("mirofish", true); // aborts the in-flight read above
  putDeferred.resolve(jsonResponse(starting, 202));
  await changePromise;

  assert.equal(clock.pendingDelay(), ACTIVE_POLL_MS, "the mutation's transition reschedule must survive the aborted read settling");
});

test("controller: real cycle-to-cycle polling slows from 2s back to 30s once a settled snapshot shows no transition", async () => {
  const clock = createFakeClock();
  const states: ControlsState[] = [];
  let getCalls = 0;

  const controller = createControlsController({
    getToken: async () => "tok",
    onState: (s) => states.push(s),
    onLoading: () => {},
    onError: () => {},
    onMutating: () => {},
    fetchImpl: (async () => {
      getCalls += 1;
      if (getCalls === 1) {
        const starting = controlsFixture(1);
        starting.apps[3] = { ...starting.apps[3], status: "Starting" };
        return jsonResponse(starting);
      }
      return jsonResponse(controlsFixture(1)); // reconciled: nothing transitioning anymore
    }) as typeof fetch,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
  });

  controller.start();
  await waitUntil(() => states.length === 1);
  assert.equal(clock.pendingDelay(), ACTIVE_POLL_MS, "a transition snapshot must schedule the 2s cadence");

  clock.fire(); // the real cycle() this scheduled runs now, issuing the next real read
  await waitUntil(() => states.length === 2);
  assert.equal(clock.pendingDelay(), IDLE_POLL_MS, "once settled idle, cadence must return to 30s");
});

// Re-review 3, Important #1: `stop()` only promised that a stopped
// controller's *scheduler* release stays local -- it did not guard the
// mutation finally's `deps.onMutating(false)` call itself. A Clerk-session
// switch/unmount calls `oldController.stop()` while that session's own PUT
// is still in flight (app-controls-provider.tsx's effect cleanup); the old
// PUT's `finally` must not later write into the shared React setter once a
// successor controller (the new session, same setState identity across
// controller instances in one provider) is already mid-mutation.
test("controller: a stopped controller's late-settling PUT never writes shared callback state for a successor session", async () => {
  const oldClock = createFakeClock();
  const oldStates: ControlsState[] = [];
  const oldPutDeferred = deferred<Response>();
  let mutatingValue: boolean | null = null;
  const sharedOnMutating = (value: boolean) => {
    mutatingValue = value;
  };

  const oldController = createControlsController({
    getToken: async () => "old-session-tok",
    onState: (s) => oldStates.push(s),
    onLoading: () => {},
    onError: () => {},
    onMutating: sharedOnMutating,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return oldPutDeferred.promise;
      return jsonResponse(controlsFixture(0));
    }) as typeof fetch,
    setTimeoutImpl: oldClock.setTimeoutImpl,
    clearTimeoutImpl: oldClock.clearTimeoutImpl,
  });

  oldController.start();
  await waitUntil(() => oldStates.length === 1);

  const oldChangePromise = oldController.change("mirofish", true); // old session's PUT begins
  await Promise.resolve();

  oldController.stop(); // Clerk session switch/unmount while the PUT is still pending
  assert.equal(oldClock.pendingCount(), 0, "stop() clears the old controller's own armed timer");

  // The successor controller for the new session -- in production this
  // shares the exact same React setMutating identity as the old one
  // (app-controls-provider.tsx constructs one controller per sessionId but
  // wires both to the same component's state setters).
  const successorClock = createFakeClock();
  const successorStates: ControlsState[] = [];
  const successorPutDeferred = deferred<Response>();
  const successorController = createControlsController({
    getToken: async () => "new-session-tok",
    onState: (s) => successorStates.push(s),
    onLoading: () => {},
    onError: () => {},
    onMutating: sharedOnMutating,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return successorPutDeferred.promise;
      return jsonResponse(controlsFixture(0));
    }) as typeof fetch,
    setTimeoutImpl: successorClock.setTimeoutImpl,
    clearTimeoutImpl: successorClock.clearTimeoutImpl,
  });

  successorController.start();
  await waitUntil(() => successorStates.length === 1);
  const successorChangePromise = successorController.change("tradingagents", false); // the new session's own real mutation
  await Promise.resolve();
  assert.equal(mutatingValue, true, "the successor's own pending mutation marks the shared state busy");

  // The old, stopped controller's PUT settles *after* the successor began
  // its own mutation. It must never clear the shared busy flag out from
  // under the successor's real pending PUT, and must never arm its own
  // timer either.
  oldPutDeferred.resolve(jsonResponse(controlsFixture(1), 202));
  await oldChangePromise;
  assert.equal(mutatingValue, true, "a stopped controller's late PUT settlement must never overwrite a successor's busy state");
  assert.equal(oldClock.pendingCount(), 0, "a stopped controller must never arm its own timer after settling");
  assert.equal(successorStates.length, 1, "the old controller's settlement must not apply its snapshot into the successor's state");

  successorPutDeferred.resolve(jsonResponse(controlsFixture(2), 202));
  await successorChangePromise;
  assert.equal(mutatingValue, false, "the successor's own mutation finishing still clears the shared busy state normally");
});

// Re-review 3, Important #2: prior coverage only drove the blocked-read
// path through `handleFocus()` (which explicitly clears the timer before
// calling `cycle()` directly); an *armed timer actually firing* while a PUT
// is pending is a distinct code path (the timer's own callback invokes
// `cycle()` without going through `handleFocus()`'s early timer-clear) and
// had no dedicated test.
test("controller: an armed timer firing while a mutation is pending never issues a GET, and the mutation's transition snapshot plus 2s timer survive", async () => {
  const clock = createFakeClock();
  const states: ControlsState[] = [];
  let getCalls = 0;
  let putCalls = 0;
  const putDeferred = deferred<Response>();

  const controller = createControlsController({
    getToken: async () => "tok",
    onState: (s) => states.push(s),
    onLoading: () => {},
    onError: () => {},
    onMutating: () => {},
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCalls += 1;
        return putDeferred.promise;
      }
      getCalls += 1;
      return jsonResponse(controlsFixture(0));
    }) as typeof fetch,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
  });

  controller.start();
  await waitUntil(() => states.length === 1);
  assert.equal(clock.pendingDelay(), IDLE_POLL_MS, "the initial settled read arms the pre-PUT idle timer");

  const changePromise = controller.change("mirofish", true); // PUT begins; the pre-existing idle timer is untouched
  await Promise.resolve();
  assert.equal(clock.pendingCount(), 1, "change() does not itself touch the already-armed timer");

  clock.fire(); // the armed timer's own callback invokes cycle() directly -- not via handleFocus()
  await Promise.resolve();
  assert.equal(getCalls, 1, "a timer firing while a mutation is pending must never issue a GET");
  assert.equal(clock.pendingCount(), 0, "the blocked cycle this timer triggered must not arm a stray timer of its own");

  const starting = controlsFixture(1);
  starting.apps[3] = { ...starting.apps[3], status: "Starting" };
  putDeferred.resolve(jsonResponse(starting, 202));
  await changePromise;

  assert.equal(putCalls, 1);
  assert.equal(states.at(-1)!.revision, 1, "the mutation's own transition snapshot is what applied");
  assert.equal(states.at(-1)!.apps[3].status, "Starting");
  assert.equal(clock.pendingDelay(), ACTIVE_POLL_MS, "the mutation's transition reschedule must survive the blocked timer firing");
});
test("Desk public shell is launchable without an upstream app-control entry", () => {
  assert.deepEqual(appLaunchGate(null, "desk"), { kind: "available" });
  assert.deepEqual(appLaunchGate(null, "desk-other"), { kind: "unknown" });
});
