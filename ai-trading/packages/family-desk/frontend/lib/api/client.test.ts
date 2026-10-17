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
  const client = createDeskApiClient(async () => Response.json({ value: Number.NaN }), () => ({ href: "" }));

  await assert.rejects(client("/api/desk/test", responseSchema), (error: unknown) => {
    assert.ok(error instanceof DeskApiError);
    assert.equal(error.kind, "malformed");
    return true;
  });
});

test("a server error throws an HTTP error with status and without its body", async () => {
  const client = createDeskApiClient(async () => new Response("secret body", { status: 503 }), () => ({ href: "" }));

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
  assert.equal(requestUrl, "/api/desk/test");
  assert.equal(requestInit?.credentials, "include");
  assert.equal(requestInit?.cache, "no-store");
  assert.equal(new Headers(requestInit?.headers).has("Cf-Access-Authenticated-User-Email"), false);
});
