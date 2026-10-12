import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { verifyToken as realVerifyToken } from "@clerk/backend";
import { createAuthServer } from "./server.js";
import { sign } from "./session.js";
import { CLERK_ISSUER, CLERK_AUDIENCE } from "./clerk.js";

const SECRET = "a".repeat(64);
const ALLOWED_ORIGIN = "https://trading.tobytran.dev";
const ENV = {
  SESSION_SIGNING_KEY: SECRET,
  ALLOWED_EMAILS: "family@tobytran.dev",
  ALLOWED_ORIGINS: ALLOWED_ORIGIN,
};

function validCookie(email = "family@tobytran.dev", expOffsetSeconds = 3600) {
  return `__ai_trading_session=${sign({ email, exp: Math.floor(Date.now() / 1000) + expOffsetSeconds }, SECRET)}`;
}

function fullClaims(overrides = {}) {
  return {
    sub: "user_123",
    email: "family@tobytran.dev",
    iss: CLERK_ISSUER,
    aud: CLERK_AUDIENCE,
    azp: ALLOWED_ORIGIN,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

// --- Real-SDK fixture for control-check signature/expiry tests ---
//
// Per task-4-reference.md: expiry/signature refusal must be exercised by
// verifier failure, not an injected fake that ignores expiry. This mints a
// genuinely RS256-signed JWT with a locally generated keypair and routes the
// server's `verifyToken` override through the real `@clerk/backend`
// `verifyToken`, networkless via its `jwtKey` option (a local PEM public key
// -- no Clerk JWKS endpoint, no Clerk credentials). Same shape as
// clerk.test.js's own real-SDK fixture.
function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mintRs256Jwt(claims, privateKey) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = base64url(cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey));
  return `${signingInput}.${signature}`;
}

const CONTROL_KEYPAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CONTROL_PUBLIC_KEY_PEM = CONTROL_KEYPAIR.publicKey.export({ type: "spki", format: "pem" });

function mintControlToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return mintRs256Jwt(
    {
      sub: "user_123",
      email: "family@tobytran.dev",
      iss: CLERK_ISSUER,
      aud: CLERK_AUDIENCE,
      azp: ALLOWED_ORIGIN,
      iat: now - 10,
      nbf: now - 10,
      exp: now + 3600,
      ...overrides,
    },
    overrides.privateKey || CONTROL_KEYPAIR.privateKey,
  );
}

// Delegates to the real SDK with a fixed jwtKey, same as clerk.js's own
// `verify` call site (secretKey/authorizedParties/audience come from
// server.js; this only supplies the networkless public key).
function realVerify(jwtKey = CONTROL_PUBLIC_KEY_PEM) {
  return (token, options) => realVerifyToken(token, { ...options, jwtKey });
}

async function withAuthServer(env, run) {
  const server = createAuthServer(env);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await run(port);
  } finally {
    server.close();
  }
}

// --- Startup validation: fail closed before ever listening ---

test("createAuthServer throws on a SESSION_SIGNING_KEY that is not 64 hex characters", () => {
  assert.throws(() => createAuthServer({ ...ENV, SESSION_SIGNING_KEY: "short" }));
});

test("createAuthServer throws on a missing SESSION_SIGNING_KEY", () => {
  const { SESSION_SIGNING_KEY, ...rest } = ENV;
  assert.throws(() => createAuthServer(rest));
});

test("createAuthServer throws on an empty ALLOWED_ORIGINS", () => {
  assert.throws(() => createAuthServer({ ...ENV, ALLOWED_ORIGINS: "" }));
});

test("createAuthServer throws on an empty ALLOWED_EMAILS", () => {
  assert.throws(() => createAuthServer({ ...ENV, ALLOWED_EMAILS: "" }));
});

// --- GET /__auth/check ---

test("GET /__auth/check is 401 with no cookie", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`);
    assert.equal(res.status, 401);
  });
});

test("GET /__auth/check is 204 with X-Verified-Email for a valid cookie", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, { headers: { cookie: validCookie() } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("x-verified-email"), "family@tobytran.dev");
  });
});

test("GET /__auth/check is 401 for an expired cookie", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, {
      headers: { cookie: validCookie("family@tobytran.dev", -10) },
    });
    assert.equal(res.status, 401);
  });
});

test("GET /__auth/check is 401 for a forged cookie (tampered signature)", async () => {
  await withAuthServer(ENV, async (port) => {
    const forged = validCookie().replace(/\.[^.]+$/, ".forgedmac");
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, { headers: { cookie: forged } });
    assert.equal(res.status, 401);
  });
});

test("GET /__auth/check is 401 for a cookie signed with a different key", async () => {
  await withAuthServer(ENV, async (port) => {
    const otherKey = "b".repeat(64);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const forged = `__ai_trading_session=${sign({ email: "family@tobytran.dev", exp }, otherKey)}`;
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, { headers: { cookie: forged } });
    assert.equal(res.status, 401);
  });
});

test("POST /__auth/check is 405 (wrong method)", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, { method: "POST" });
    assert.equal(res.status, 405);
  });
});

// --- POST /__auth/session: Origin-before-everything ---

test("POST /__auth/session rejects a disallowed Origin before examining the Authorization header", async () => {
  await withAuthServer(ENV, async (port) => {
    // No Authorization header at all -- if the header were checked first this
    // would be 400, not 403. Proves Origin is the first gate.
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: "https://evil.example.test" },
    });
    assert.equal(res.status, 403);
  });
});

test("POST /__auth/session rejects a missing Origin header", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, { method: "POST" });
    assert.equal(res.status, 403);
  });
});

// --- POST /__auth/session: Authorization header parsing ---

test("POST /__auth/session is 400 for a missing Authorization header (allowed Origin)", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN },
    });
    assert.equal(res.status, 400);
  });
});

test("POST /__auth/session is 400 for an Authorization header without the Bearer scheme", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Token abc123" },
    });
    assert.equal(res.status, 400);
  });
});

test("POST /__auth/session is 400 for a Bearer header with no token", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer " },
    });
    assert.equal(res.status, 400);
  });
});

// P2 regression: a single token must be exactly one whitespace-free segment.
// A naive `/^Bearer\s+(.+)$/i` happily captures "token extra" (with the
// embedded space) as the "token", which only fails later -- 401 from
// `verifyClerkToken`, not 400 for a malformed header as the binding ledger
// requires. These assert 400 directly over real HTTP, not just regex shape.
test("POST /__auth/session is 400 for a Bearer header with two space-separated tokens", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer token extra" },
    });
    assert.equal(res.status, 400);
  });
});

test("POST /__auth/session is 400 for a Bearer header with a tab-separated second token", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer token\textra" },
    });
    assert.equal(res.status, 400);
  });
});

test("POST /__auth/session is 400 for a Bearer header with an embedded tab inside one token", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer tok\ten" },
    });
    assert.equal(res.status, 400);
  });
});

test("POST /__auth/session accepts a single token with extra inter-field whitespace", async () => {
  const env = { ...ENV, verifyToken: async () => ({ data: fullClaims() }) };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer   real-looking-clerk-token  " },
    });
    assert.equal(res.status, 204);
  });
});

// --- POST /__auth/session: verification outcomes ---

test("POST /__auth/session issues a cookie for a verified, allowed Clerk user", async () => {
  const env = { ...ENV, verifyToken: async () => ({ data: fullClaims() }) };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer real-looking-clerk-token" },
    });
    assert.equal(res.status, 204);
    const setCookie = res.headers.get("set-cookie");
    assert.match(setCookie, /^__ai_trading_session=/);
    assert.match(setCookie, /Domain=tobytran\.dev/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=3600/);
  });
});

test("POST /__auth/session rejects a verified user who is not on the allowlist", async () => {
  const env = {
    ...ENV,
    verifyToken: async () => ({ data: fullClaims({ sub: "user_2", email: "stranger@example.com" }) }),
  };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer real-looking-clerk-token" },
    });
    assert.equal(res.status, 401);
  });
});

test("POST /__auth/session rejects an unverifiable token (e.g. bad signature upstream)", async () => {
  const env = { ...ENV, verifyToken: async () => ({ errors: [{ message: "bad signature" }] }) };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer whatever" },
    });
    assert.equal(res.status, 401);
  });
});

test("POST /__auth/session rejects a token missing the operator-provisioned email claim", async () => {
  const env = {
    ...ENV,
    verifyToken: async () => {
      const claims = fullClaims();
      delete claims.email;
      return { data: claims };
    },
  };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer real-looking-clerk-token" },
    });
    assert.equal(res.status, 401);
  });
});

test("GET /__auth/session is 405 (wrong method)", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`);
    assert.equal(res.status, 405);
  });
});

// --- POST /__auth/logout: expire this browser's cookie, not copied tokens ---

test("POST /__auth/logout expires the shared HttpOnly cookie on an allowed origin", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/logout`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, cookie: validCookie() },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("set-cookie"), "__ai_trading_session=; Domain=tobytran.dev; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const check = await fetch(`http://127.0.0.1:${port}/__auth/check`, {
      headers: { cookie: res.headers.get("set-cookie").split(";")[0] },
    });
    assert.equal(check.status, 401);
  });
});

test("POST /__auth/logout is idempotent and accepts the configured staging origin", async () => {
  const staging = "https://trading-static.tobytran.dev";
  await withAuthServer({ ...ENV, ALLOWED_ORIGINS: `${ALLOWED_ORIGIN},${staging}` }, async (port) => {
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/__auth/logout`, { method: "POST", headers: { origin: staging } });
      assert.equal(res.status, 204);
      assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
    }
  });
});

test("POST /__auth/logout refuses missing or cross-site origins without clearing cookies", async () => {
  await withAuthServer(ENV, async (port) => {
    for (const origin of [undefined, "https://evil.example.test", `${ALLOWED_ORIGIN}.evil.example.test`]) {
      const res = await fetch(`http://127.0.0.1:${port}/__auth/logout`, {
        method: "POST",
        headers: { cookie: validCookie(), ...(origin ? { origin } : {}) },
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("set-cookie"), null);
    }
  });
});

test("GET /__auth/logout refuses the wrong method without clearing cookies", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/logout`, { headers: { origin: ALLOWED_ORIGIN, cookie: validCookie() } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("set-cookie"), null);
  });
});

// --- Unknown route ---

test("an unknown path is 404", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/not-a-route`);
    assert.equal(res.status, 404);
  });
});

// --- GET /__auth/control-check (Task 4): fresh bearer only, never a cookie ---
//
// Caddy's forward_auth always calls this endpoint with GET and supplies the
// real browser method via X-Forwarded-Method; this never falls back to the
// gateway cookie that /__auth/check accepts.

test("control auth never accepts a gateway cookie alone", async () => {
  await withAuthServer(ENV, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: { cookie: validCookie(), "x-forwarded-method": "GET" },
    });
    assert.equal(r.status, 401);
  });
});

test("control mutation rejects Origin before invoking verification", async () => {
  let called = false;
  await withAuthServer({ ...ENV, verifyToken: async () => { called = true; return { data: fullClaims() }; } }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: { authorization: "Bearer fixture", "x-forwarded-method": "PUT", origin: "https://wrong.example.test" },
    });
    assert.equal(r.status, 403);
    assert.equal(called, false);
  });
});

test("valid control token returns its verified subject", async () => {
  await withAuthServer({ ...ENV, verifyToken: async () => ({ data: fullClaims() }) }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: { authorization: "Bearer fixture", "x-forwarded-method": "PUT", origin: ALLOWED_ORIGIN },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("x-verified-actor"), "user_123");
  });
});

test("control check on a GET request never checks Origin at all", async () => {
  await withAuthServer({ ...ENV, verifyToken: async () => ({ data: fullClaims() }) }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: { authorization: "Bearer fixture", "x-forwarded-method": "GET" },
    });
    assert.equal(r.status, 204);
  });
});

test("control check is 405 for the actual (Caddy-side) HTTP method other than GET", async () => {
  await withAuthServer(ENV, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      method: "POST",
      headers: { authorization: "Bearer fixture", "x-forwarded-method": "GET" },
    });
    assert.equal(r.status, 405);
  });
});

test("control check is 405 for an unsupported forwarded method", async () => {
  await withAuthServer({ ...ENV, verifyToken: async () => ({ data: fullClaims() }) }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: { authorization: "Bearer fixture", "x-forwarded-method": "DELETE", origin: ALLOWED_ORIGIN },
    });
    assert.equal(r.status, 405);
  });
});

test("control check is 401 for a missing Authorization header", async () => {
  await withAuthServer(ENV, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: { "x-forwarded-method": "GET" },
    });
    assert.equal(r.status, 401);
  });
});

test("control check is 401 for a verified user not on the allowlist", async () => {
  await withAuthServer(
    { ...ENV, verifyToken: async () => ({ data: fullClaims({ sub: "user_2", email: "stranger@example.com" }) }) },
    async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
        headers: { authorization: "Bearer fixture", "x-forwarded-method": "GET" },
      });
      assert.equal(r.status, 401);
    },
  );
});

test("control check is 401 for a wrong issuer", async () => {
  await withAuthServer(
    { ...ENV, verifyToken: async () => ({ data: fullClaims({ iss: "https://attacker.example.clerk.accounts.dev" }) }) },
    async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
        headers: { authorization: "Bearer fixture", "x-forwarded-method": "GET" },
      });
      assert.equal(r.status, 401);
    },
  );
});

test("control check is 401 for a wrong audience", async () => {
  await withAuthServer(
    { ...ENV, verifyToken: async () => ({ data: fullClaims({ aud: "https://some-other-app.example" }) }) },
    async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
        headers: { authorization: "Bearer fixture", "x-forwarded-method": "GET" },
      });
      assert.equal(r.status, 401);
    },
  );
});

test("control check is 401 for an azp not in the authorized-party allowlist", async () => {
  await withAuthServer(
    { ...ENV, verifyToken: async () => ({ data: fullClaims({ azp: "https://not-allowed.example" }) }) },
    async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
        headers: { authorization: "Bearer fixture", "x-forwarded-method": "GET" },
      });
      assert.equal(r.status, 401);
    },
  );
});

test("control check is 401 for an unsafe subject (not the helper's actor-ID shape)", async () => {
  await withAuthServer(
    { ...ENV, verifyToken: async () => ({ data: fullClaims({ sub: "user/../../etc" }) }) },
    async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
        headers: { authorization: "Bearer fixture", "x-forwarded-method": "GET" },
      });
      assert.equal(r.status, 401);
    },
  );
});

test("control check never trusts a client-supplied X-Verified-Actor header", async () => {
  await withAuthServer({ ...ENV, verifyToken: async () => ({ data: fullClaims() }) }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: {
        authorization: "Bearer fixture",
        "x-forwarded-method": "GET",
        "x-verified-actor": "attacker_999",
      },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("x-verified-actor"), "user_123");
  });
});

// --- Real-SDK signature/expiry refusal (not an injected fake) ---

test("control check rejects a genuinely expired real-SDK-signed token", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = mintControlToken({ iat: now - 7200, nbf: now - 7200, exp: now - 10 });
  await withAuthServer({ ...ENV, verifyToken: realVerify() }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: { authorization: `Bearer ${expired}`, "x-forwarded-method": "GET" },
    });
    assert.equal(r.status, 401);
  });
});

test("control check rejects a token signed with the wrong private key (bad signature)", async () => {
  const otherKeypair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const forged = mintControlToken({ privateKey: otherKeypair.privateKey });
  await withAuthServer({ ...ENV, verifyToken: realVerify() }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: { authorization: `Bearer ${forged}`, "x-forwarded-method": "GET" },
    });
    assert.equal(r.status, 401);
  });
});

test("control check accepts a genuinely signed, unexpired, allowed real-SDK token", async () => {
  const token = mintControlToken();
  await withAuthServer({ ...ENV, verifyToken: realVerify() }, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: { authorization: `Bearer ${token}`, "x-forwarded-method": "GET" },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("x-verified-actor"), "user_123");
  });
});

// --- Unrelated routes are untouched by this new endpoint ---

test("/__auth/control-check is still 404 for a POST to an otherwise-valid-looking path with a wrong method entirely unknown", async () => {
  await withAuthServer(ENV, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check/extra`);
    assert.equal(r.status, 404);
  });
});
