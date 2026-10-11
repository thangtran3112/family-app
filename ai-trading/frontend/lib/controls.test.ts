import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_POLL_MS,
  appLaunchGate,
  changeApp,
  createGenerationGate,
  fetchApps,
  IDLE_POLL_MS,
  isRefreshableConflict,
  launchBlockedCopy,
  nextPollDelayMs,
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

test("generation gate: only the most recently begun ticket is ever accepted, independent of settle order", () => {
  const gate = createGenerationGate();
  const read1 = gate.begin();
  const mutation = gate.begin(); // e.g. a PUT issued while read1 is still in flight
  assert.equal(gate.accepts(mutation), true);
  // read1 settling *after* the mutation must not be allowed to overwrite it,
  // even though it carries no information about the mutation's existence.
  assert.equal(gate.accepts(read1), false);

  const read2 = gate.begin();
  assert.equal(gate.accepts(mutation), false, "mutation is now also superseded");
  assert.equal(gate.accepts(read2), true);
});

test("generation gate accepts a ticket that is still the latest when it resolves", () => {
  const gate = createGenerationGate();
  const only = gate.begin();
  assert.equal(gate.accepts(only), true);
});

test("integration: a deferred GET that resolves after a PUT never overwrites the PUT's result", async () => {
  // Exactly the scenario from fix-round-1 review Important #2, driven
  // through the real fetchApps/changeApp/createGenerationGate -- the same
  // three production pieces app-controls-provider.tsx composes -- with a
  // controllable deferred GET response, not a copy/mock of the provider.
  const gate = createGenerationGate();
  let resolveGet!: (value: Response) => void;
  const getResponse = new Promise<Response>((resolve) => {
    resolveGet = resolve;
  });

  const getTicket = gate.begin();
  const getOutcome = fetchApps(async () => "tok", async () => getResponse).then(
    (value) => (gate.accepts(getTicket) ? value : null),
    () => null,
  );

  // A PUT is issued (and settles) while the GET above is still pending --
  // it takes a newer ticket than the GET's.
  const putTicket = gate.begin();
  const putResult = await changeApp("mirofish", true, 0, async () => "tok", async () => jsonResponse(controlsFixture(5), 202));
  assert.equal(gate.accepts(putTicket), true);
  assert.equal(putResult.revision, 5);

  // Only now does the stale GET resolve, carrying an older revision.
  resolveGet(jsonResponse(controlsFixture(0)));
  assert.equal(await getOutcome, null, "the stale GET must be dropped, not applied, after a newer mutation already settled");
});
