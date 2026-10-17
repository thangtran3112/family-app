import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./desk-router.js";

const ENV = { STATIC_BUCKET: "test-desk", ORIGIN_HOSTNAME: "trading-origin.tobytran.dev" };
const request = (path, init) => new Request(`https://trading.tobytran.dev${path}`, init);
async function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("public static pages and assets resolve without sending cookies or queries to GCS", async () => {
  for (const [path, key] of [["/", "index.html"], ["/strategies/?id=1", "strategies.html"], ["/futures/specs", "futures/specs.html"], ["/_next/static/a.js", "_next/static/a.js"]]) {
    await withFetch(async (url, init) => {
      assert.equal(url, `https://storage.googleapis.com/test-desk/${key}`);
      assert.deepEqual(init, { method: "GET" });
      return new Response("public shell", { headers: { "x-goog-hash": "internal" } });
    }, async () => {
      const response = await worker.fetch(request(path, { headers: { cookie: "session=private" } }), ENV);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "public shell");
      assert.equal(response.headers.get("x-goog-hash"), null);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
      assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
      assert.match(response.headers.get("strict-transport-security"), /max-age=31536000/);
    });
  }
});

test("missing static asset returns actual 404 fallback, including HEAD", async () => {
  for (const method of ["GET", "HEAD"]) {
    const calls = [];
    await withFetch(async (url, init) => {
      calls.push(url);
      assert.equal(init.method, method);
      return url.endsWith("/404.html")
        ? new Response(method === "HEAD" ? null : "not found", { headers: { "content-type": "text/html" } })
        : new Response(null, { status: 404 });
    }, async () => {
      const response = await worker.fetch(request("/missing.js", { method }), ENV);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(await response.text(), method === "HEAD" ? "" : "not found");
      assert.deepEqual(calls, ["https://storage.googleapis.com/test-desk/missing.js", "https://storage.googleapis.com/test-desk/404.html"]);
    });
  }
});

test("Desk API preserves cookie, query, method and body, with cache bypass and manual redirects", async () => {
  await withFetch(async (forwarded, options) => {
    assert.equal(forwarded.url, "https://trading-origin.tobytran.dev/api/desk/strategies?x=1");
    assert.equal(forwarded.method, "POST");
    assert.equal(forwarded.headers.get("cookie"), "session=opaque");
    assert.equal(forwarded.headers.get("origin"), "https://trading.tobytran.dev");
    assert.equal(await forwarded.text(), '{"name":"test"}');
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "manual");
    return new Response("unauthorized", { status: 401, headers: { "cache-control": "public, max-age=3600" } });
  }, async () => {
    const response = await worker.fetch(request("/api/desk/strategies?x=1", {
      method: "POST", headers: { cookie: "session=opaque", origin: "https://trading.tobytran.dev" }, body: '{"name":"test"}',
    }), ENV);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "unauthorized");
  });
});

test("SSE streams first chunk before upstream closes, with no-store even on successful responses", { timeout: 1000 }, async () => {
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; value.enqueue(new TextEncoder().encode("event: quote\ndata: {}\n\n")); } });
  await withFetch(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }), async () => {
    const response = await worker.fetch(request("/api/desk/quotes/AAPL"), ENV);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "event: quote\ndata: {}\n\n");
    controller.close();
    assert.equal((await reader.read()).done, true);
  });
});

test("other API prefixes never reach a public bucket or another origin API", async () => {
  await withFetch(() => { throw new Error("unexpected upstream fetch"); }, async () => {
    for (const path of ["/api", "/api/", "/api/desk", "/api/desk-other/private", "/api/other"]) {
      const response = await worker.fetch(request(path), ENV);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const response = await worker.fetch(request("/strategies", { method: "POST", body: "x" }), ENV);
    assert.equal(response.status, 405);
  });
});
