import { test } from "node:test";
import assert from "node:assert/strict";
import { changeApp, fetchApps, isAppConfirmedRunning, isAppKnownStopped, type AppId, type ControlsState } from "./controls.ts";

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

test("isAppConfirmedRunning is true only for an enabled app actually Running", () => {
  const state = controlsFixture();
  assert.equal(isAppConfirmedRunning(state, "tradingagents"), true);
  assert.equal(isAppConfirmedRunning(state, "mirofish"), false);
  assert.equal(isAppConfirmedRunning(null, "tradingagents"), false);
  assert.equal(isAppConfirmedRunning(state, "not-a-real-app" as AppId), false);
});

test("isAppKnownStopped stays false while unknown, true only once confirmed not running", () => {
  const state = controlsFixture();
  assert.equal(isAppKnownStopped(null, "tradingagents"), false, "no snapshot yet: not definitely stopped");
  assert.equal(isAppKnownStopped(state, "not-a-real-app" as AppId), false, "missing entry: not definitely stopped");
  assert.equal(isAppKnownStopped(state, "tradingagents"), false, "actually running");
  assert.equal(isAppKnownStopped(state, "mirofish"), true, "actually stopped");
});
