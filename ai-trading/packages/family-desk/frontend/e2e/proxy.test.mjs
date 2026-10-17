import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createE2EServer } from "./proxy.mjs";

const root = await mkdtemp(join(tmpdir(), "desk-e2e-proxy-"));
await writeFile(join(root, "index.html"), "<main>desk export</main>");
await writeFile(join(root, "404.html"), "<main>static 404</main>");
after(() => rm(root, { recursive: true, force: true }));

async function listening(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closed(server) {
  if (server.listening) {
    const done = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await done;
  }
}

async function within(promise, milliseconds) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("upstream stayed open")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function setup(handler) {
  const upstream = createServer(handler);
  const apiTarget = await listening(upstream);
  const proxy = createE2EServer({ root, apiTarget });
  const origin = await listening(proxy);
  return { origin, upstream, proxy };
}

test("forged verified identity is stripped; only reserved cookie installs e2e identity", async () => {
  const seen = [];
  const servers = await setup((req, res) => {
    seen.push({
      identity: req.headers["cf-access-authenticated-user-email"],
      verified: req.headers["x-verified-email"],
      userEmail: req.headers["x-user-email"],
      oidc: req.headers["x-amzn-oidc-identity"],
      forwardedCert: req.headers["x-forwarded-client-cert"],
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    res.writeHead(req.headers["cf-access-authenticated-user-email"] ? 200 : 401, {
      "content-type": "application/json",
    });
    res.end('{"ok":true}');
  });
  try {
    const forged = await fetch(`${servers.origin}/api/desk/strategies`, {
      headers: {
        "Cf-Access-Authenticated-User-Email": "attacker@example.test",
        "X-Verified-Email": "attacker@example.test",
        "X-User-Email": "attacker@example.test",
        "X-Amzn-Oidc-Identity": "attacker@example.test",
        "X-Forwarded-Client-Cert": "forged-cert-identity",
        authorization: "Bearer must-not-echo",
      },
    });
    assert.equal(forged.status, 401);
    const forgedBody = await forged.text();
    assert.equal(forgedBody, '{"ok":true}');
    assert.ok(!forgedBody.includes("must-not-echo"));

    const allowed = await fetch(`${servers.origin}/api/desk/strategies`, {
      headers: {
        cookie: "desk_e2e_session=1",
        "Cf-Access-Authenticated-User-Email": "attacker@example.test",
      },
    });
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), '{"ok":true}');
    assert.deepEqual(seen, [
      {
        identity: undefined,
        verified: undefined,
        userEmail: undefined,
        oidc: undefined,
        forwardedCert: undefined,
        authorization: undefined,
        cookie: undefined,
      },
      {
        identity: "e2e@example.test",
        verified: undefined,
        userEmail: undefined,
        oidc: undefined,
        forwardedCert: undefined,
        authorization: undefined,
        cookie: undefined,
      },
    ]);
  } finally {
    await closed(servers.proxy);
    await closed(servers.upstream);
  }
});

test("forwards method, encoded path, query, body, and upstream status", async () => {
  let seen;
  const servers = await setup(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen = {
      method: req.method,
      url: req.url,
      body: Buffer.concat(chunks).toString(),
      identity: req.headers["cf-access-authenticated-user-email"],
      cookie: req.headers.cookie,
    };
    res.writeHead(207, { "content-type": "text/plain" });
    res.end("upstream response");
  });
  try {
    const response = await fetch(`${servers.origin}/api/desk/watchlists/%2FES?interval=1m&x=a%2Fb`, {
      method: "PATCH",
      headers: {
        cookie: "desk_e2e_session=1; unrelated=session",
        "content-type": "application/json",
      },
      body: '{"name":"changed"}',
    });
    assert.equal(response.status, 207);
    assert.equal(await response.text(), "upstream response");
    assert.deepEqual(seen, {
      method: "PATCH",
      url: "/api/desk/watchlists/%2FES?interval=1m&x=a%2Fb",
      body: '{"name":"changed"}',
      identity: "e2e@example.test",
      cookie: "unrelated=session",
    });
  } finally {
    await closed(servers.proxy);
    await closed(servers.upstream);
  }
});

test("static export uses the existing server and unknown API paths never fall back to static HTML", async () => {
  const servers = await setup((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"detail":"not found"}');
  });
  try {
    const page = await fetch(`${servers.origin}/`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<main>desk export</main>");

    const missing = await fetch(`${servers.origin}/api/desk/not-a-route`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("content-type"), "application/json");
    assert.equal(await missing.text(), '{"detail":"not found"}');
  } finally {
    await closed(servers.proxy);
    await closed(servers.upstream);
  }
});

test("streams first upstream chunk without buffering and cancels upstream on client close", async () => {
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => {
    resolveUpstreamClosed = resolve;
  });
  const servers = await setup((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: quote\ndata: first\n\n");
    res.on("close", resolveUpstreamClosed);
  });
  const controller = new AbortController();
  try {
    const response = await fetch(`${servers.origin}/api/desk/quotes/NVDA`, {
      headers: { cookie: "desk_e2e_session=1" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), "event: quote\ndata: first\n\n");
    controller.abort();
    await within(upstreamClosed, 1000);
  } finally {
    controller.abort();
    await closed(servers.proxy);
    await closed(servers.upstream);
  }
});
