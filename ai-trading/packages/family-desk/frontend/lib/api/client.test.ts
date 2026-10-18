import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createDeskApiClient, DeskApiError } from "./client.ts";

const responseSchema = z.object({ value: z.number().finite() });

test("a 401 redirects once to hub login and throws unauthenticated", async () => {
  let href = "https://trading.tobytran.dev/strategies";
  let redirectCount = 0;
  const location = {
    get href() {
      return href;
    },
    set href(value: string) {
      href = value;
      redirectCount += 1;
    },
  };
  const client = createDeskApiClient(async () => new Response("secret body", { status: 401 }), () => location);

  await assert.rejects(client("/api/desk/test", responseSchema), (error: unknown) => {
    assert.ok(error instanceof DeskApiError);
    assert.equal(error.kind, "unauthenticated");
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /secret body/);
    return true;
  });
  await assert.rejects(client("/api/desk/test", responseSchema), { kind: "unauthenticated" });

  assert.equal(href, "https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Ftrading.tobytran.dev%2Fstrategies");
  assert.equal(redirectCount, 1);
});

test("a successful response that fails its schema throws malformed", async () => {
  const client = createDeskApiClient(
    async () => Response.json({ value: Number.NaN }),
    () => ({ href: "https://trading.tobytran.dev/" }),
  );

  await assert.rejects(client("/api/desk/test", responseSchema), (error: unknown) => {
    assert.ok(error instanceof DeskApiError);
    assert.equal(error.kind, "malformed");
    return true;
  });
});

test("a server error throws an HTTP error with status and without its body", async () => {
  const client = createDeskApiClient(
    async () => new Response("secret body", { status: 503 }),
    () => ({ href: "https://trading.tobytran.dev/" }),
  );

  await assert.rejects(client("/api/desk/test", responseSchema), (error: unknown) => {
    assert.ok(error instanceof DeskApiError);
    assert.equal(error.kind, "http");
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /secret body/);
    return true;
  });
});

test("requests are same-origin, include credentials, skip caching, and send no identity header", async () => {
  let requestUrl: RequestInfo | URL | undefined;
  let requestInit: RequestInit | undefined;
  const client = createDeskApiClient(
    async (input, init) => {
      requestUrl = input;
      requestInit = init;
      return Response.json({ value: 7 });
    },
    () => ({ href: "https://trading.tobytran.dev/" }),
  );

  assert.deepEqual(await client("/api/desk/test", responseSchema, {
    headers: { "Cf-Access-Authenticated-User-Email": "forged-identity" },
  }), { value: 7 });
  assert.ok(requestUrl instanceof URL);
  assert.equal(requestUrl.origin, "https://trading.tobytran.dev");
  assert.equal(requestUrl.pathname, "/api/desk/test");
  assert.equal(requestInit?.credentials, "include");
  assert.equal(requestInit?.cache, "no-store");
  assert.equal(new Headers(requestInit?.headers).has("Cf-Access-Authenticated-User-Email"), false);
});

test("rejects API paths that escape the normalized Desk prefix before fetching", async () => {
  let fetchCalls = 0;
  const client = createDeskApiClient(
    async () => {
      fetchCalls += 1;
      return Response.json({ value: 1 });
    },
    () => ({ href: "https://trading.tobytran.dev/" }),
  );

  for (const path of [
    "/api/desk/../auth/logout",
    "/api/desk/%2e%2e/%2e%2e/auth/logout",
    "/api/desk/\\..\\auth/logout",
    "https://attacker.invalid/api/desk/test",
    "//attacker.invalid/api/desk/test",
  ]) {
    await assert.rejects(client(path, responseSchema), (error: unknown) => {
      assert.ok(error instanceof DeskApiError);
      assert.equal(error.kind, "malformed");
      return true;
    });
  }

  assert.equal(fetchCalls, 0);
});

test("a 204 response validates undefined against the caller schema", async () => {
  const client = createDeskApiClient(
    async () => new Response(null, { status: 204 }),
    () => ({ href: "https://trading.tobytran.dev/" }),
  );

  assert.equal(await client("/api/desk/watchlists/1/items/AAPL", z.void()), undefined);
});

test("a 204 response with an incompatible schema remains malformed", async () => {
  const client = createDeskApiClient(
    async () => new Response(null, { status: 204 }),
    () => ({ href: "https://trading.tobytran.dev/" }),
  );

  await assert.rejects(client("/api/desk/watchlists/1/items/AAPL", z.string()), (error: unknown) => {
    assert.ok(error instanceof DeskApiError);
    assert.equal(error.kind, "malformed");
    assert.equal(error.status, 204);
    return true;
  });
});

test("a 200 response with invalid JSON remains malformed", async () => {
  const client = createDeskApiClient(
    async () => new Response("{", { status: 200 }),
    () => ({ href: "https://trading.tobytran.dev/" }),
  );

  await assert.rejects(client("/api/desk/test", responseSchema), (error: unknown) => {
    assert.ok(error instanceof DeskApiError);
    assert.equal(error.kind, "malformed");
    assert.equal(error.status, 200);
    return true;
  });
});
