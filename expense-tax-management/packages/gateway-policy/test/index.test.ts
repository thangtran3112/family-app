import { describe, expect, it } from "vitest";
import {
  GATEWAY_LIMITS,
  authorizationRateKey,
  classifyGatewayRoute,
  createGatewayRateLimiter,
} from "../src/index.js";

describe("gateway policy limits", () => {
  it("defines bounded limits for each route class", () => {
    expect(GATEWAY_LIMITS.webhook.max).toBe(20);
    expect(GATEWAY_LIMITS.api.max).toBe(120);
    expect(GATEWAY_LIMITS.internal.max).toBe(300);
    expect(GATEWAY_LIMITS.health.max).toBe(30);
  });

  it("tracks remaining requests and resets at the fixed window boundary", () => {
    let now = 0;
    const limiter = createGatewayRateLimiter({ clock: () => now });

    const first = limiter.check("health", "client");
    const second = limiter.check("health", "client");

    expect(first).toMatchObject({ allowed: true, limit: 30, remaining: 29 });
    expect(second.remaining).toBe(28);

    now = 59_999;
    expect(limiter.check("health", "client").remaining).toBe(27);
    now = 60_000;
    expect(limiter.check("health", "client")).toMatchObject({
      allowed: true,
      remaining: 29,
      retryAfterSeconds: 0,
    });
  });

  it("returns retry-after when a route class reaches its limit", () => {
    const now = 20_000;
    const limiter = createGatewayRateLimiter({ clock: () => now });

    for (let count = 0; count < GATEWAY_LIMITS.webhook.max; count += 1) {
      expect(limiter.check("webhook", "client").allowed).toBe(true);
    }

    expect(limiter.check("webhook", "client")).toEqual({
      allowed: false,
      limit: 20,
      remaining: 0,
      retryAfterSeconds: 60,
    });
  });

  it("prunes old entries while keeping state bounded", () => {
    let now = 0;
    const limiter = createGatewayRateLimiter({ clock: () => now });

    for (let count = 0; count < 1_025; count += 1) {
      limiter.check("api", `client-${count}`);
    }

    expect(limiter.size()).toBeLessThanOrEqual(1_024);
    now = 60_000;
    limiter.check("api", "fresh-client");
    expect(limiter.size()).toBe(1);
    limiter.clear();
    expect(limiter.size()).toBe(0);
  });
});

describe("gateway route classification", () => {
  it.each([
    ["/health/live", "health"],
    ["/health/ready", "health"],
    ["/api/v1/integrations/clerk/webhook", "webhook"],
    ["/internal/v1/jobs", "internal"],
    ["/api/v1/expenses", "api"],
  ] as const)("classifies %s as %s", (path, expected) => {
    expect(classifyGatewayRoute(path)).toBe(expected);
  });
});

describe("authorization rate keys", () => {
  it("uses only trusted transport identity", () => {
    const key = authorizationRateKey({
      remoteAddress: "192.0.2.10",
    });

    expect(key).toBe("address:192.0.2.10");
  });

  it("uses remote address when authorization is absent", () => {
    expect(
      authorizationRateKey({ remoteAddress: "192.0.2.10" }),
    ).toBe("address:192.0.2.10");
  });
});
