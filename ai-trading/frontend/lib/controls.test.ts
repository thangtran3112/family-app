import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_POLL_MS,
  appLaunchGate,
  changeApp,
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
  type ReadOutcome,
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
  const mutationTicket = s.beginMutation();
  assert.equal(s.attemptRead(), null, "a read must not even start while a mutation is pending");
  assert.equal(s.isCurrent(mutationTicket), true, "the refused read attempt must not have touched the generation");
  s.endMutation();
  assert.notEqual(s.attemptRead(), null, "a new read is allowed once the mutation ends");
});

test("scheduler: a read already in flight when a mutation begins is invalidated regardless of settle order", () => {
  for (const readSettlesFirst of [true, false]) {
    const s = createControlsScheduler();
    const readTicket = s.attemptRead()!.ticket;
    const mutationTicket = s.beginMutation();
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

test("integration: a deferred GET that resolves after a PUT never overwrites the PUT's result", async () => {
  // Fix-round-1 review Important #2, driven through the real
  // fetchApps/changeApp/createControlsScheduler -- the same production
  // pieces app-controls-provider.tsx composes -- with a controllable
  // deferred GET response, not a copy/mock of the provider.
  const scheduler = createControlsScheduler();
  let resolveGet!: (value: Response) => void;
  const getResponse = new Promise<Response>((resolve) => {
    resolveGet = resolve;
  });

  const getTicket = scheduler.attemptRead()!.ticket;
  const getOutcome = fetchApps(async () => "tok", async () => getResponse).then(
    (value) => (scheduler.isCurrent(getTicket) ? value : null),
    () => null,
  );

  // A PUT is issued (and settles) while the GET above is still pending.
  const putTicket = scheduler.beginMutation();
  const putResult = await changeApp("mirofish", true, 0, async () => "tok", async () => jsonResponse(controlsFixture(5), 202));
  assert.equal(scheduler.isCurrent(putTicket), true);
  assert.equal(putResult.revision, 5);
  scheduler.endMutation();

  // Only now does the stale GET resolve, carrying an older revision.
  resolveGet(jsonResponse(controlsFixture(0)));
  assert.equal(await getOutcome, null, "the stale GET must be dropped, not applied, after a newer mutation already settled");
});

test("integration: a GET attempted via focus/timer while a PUT is pending never starts, and the PUT's transition cadence survives", async () => {
  // Fix-round-2 review Important #1 + #2 together: the exact sequence
  // "PUT begins -> focus/timer GET attempt -> GET/PUT settle" with the real
  // changeApp + createControlsScheduler + pollDelayAfter, proving the PUT's
  // own successful transition snapshot is what schedules the next poll, not
  // a 30s idle fallback from a read that should never have started.
  const scheduler = createControlsScheduler();

  const putTicket = scheduler.beginMutation();

  // Focus/timer fires while the PUT is still in flight.
  const blockedAttempt = scheduler.attemptRead();
  assert.equal(blockedAttempt, null, "a read during a pending mutation must be refused, not merely outraced");

  const startingSnapshot = controlsFixture(1);
  startingSnapshot.apps[3] = { ...startingSnapshot.apps[3], status: "Starting" };
  const putResult = await changeApp("mirofish", true, 0, async () => "tok", async () => jsonResponse(startingSnapshot, 202));
  assert.equal(scheduler.isCurrent(putTicket), true, "the PUT's own snapshot must still be current -- nothing superseded it");
  scheduler.endMutation();

  // The PUT's own outcome is what the provider reschedules from (never
  // routed through pollDelayAfter's "stale" path, since it was never
  // refused or invalidated) -- and it must select the 2s transition cadence.
  assert.equal(nextPollDelayMs(putResult), ACTIVE_POLL_MS);

  // Only after endMutation() can the next, intentional read begin -- this
  // is what eventually carries the system from transition back to idle.
  const reconcileTicket = scheduler.attemptRead();
  assert.notEqual(reconcileTicket, null);
  const idleSnapshot = controlsFixture(1); // reconciled: no app is transitioning anymore
  assert.equal(scheduler.isCurrent(reconcileTicket!.ticket), true);
  assert.equal(pollDelayAfter({ kind: "applied", state: idleSnapshot }), IDLE_POLL_MS);
});

test("integration: a read aborted by a mutation that begins just after it starts must never reschedule (stale, not failed)", () => {
  // Fix-round-2 review Important #2: an in-flight read invalidated by a
  // mutation must produce a "stale" outcome -- pollDelayAfter(stale) is the
  // one thing that prevents it from calling schedule(null) (30s) over top
  // of the mutation's own 2s reschedule.
  const scheduler = createControlsScheduler();
  const readTicket = scheduler.attemptRead()!.ticket;
  scheduler.beginMutation(); // a PUT begins before the read above has settled
  const outcome: ReadOutcome = scheduler.isCurrent(readTicket) ? { kind: "failed" } : { kind: "stale" };
  assert.deepEqual(outcome, { kind: "stale" });
  assert.equal(pollDelayAfter(outcome), null, "an invalidated read must never reschedule");
});
