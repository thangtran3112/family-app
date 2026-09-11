import { describe, expect, it } from "vitest";

import {
  buildSmokePlan,
  parseSmokeConfig,
  redactHeaders,
  runSmokeTests,
} from "./production-auth-smoke.mjs";

function response(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function config(overrides = {}) {
  return {
    appApiUrl: "https://app.example.test",
    foundryUrl: "https://foundry.example.test",
    captureUrl: "https://capture.example.test",
    officeUrl: "https://office.example.test",
    tenantId: "family-tenant",
    mismatchTenantId: "other-tenant",
    expectedIssuer: "https://clerk.example.test",
    expectedTenantAudience: "family-tenant-aud",
    expectedPlatformAudience: "family-platform-aud",
    expectedAppM2mAudience: "app-api-machine",
    expectedFoundryM2mAudience: "foundry-service-machine",
    thangTenantToken: "thang-tenant-secret",
    thangPlatformToken: "thang-platform-secret",
    tramilyTenantToken: "tramily-tenant-secret",
    appM2mToken: "app-m2m-secret",
    foundryM2mToken: "foundry-m2m-secret",
    webhookReplayUrl: "https://app.example.test/api/v1/integrations/clerk/webhook",
    webhookReplayBody: '{"id":"evt_test","type":"user.updated","data":{}}',
    webhookReplayHeaders: {
      "svix-id": "msg_test",
      "svix-timestamp": "1700000000",
      "svix-signature": "v1,test-signature",
    },
    ...overrides,
  };
}

describe("production auth smoke helpers", () => {
  it("rejects missing required values without exposing secret values", () => {
    expect(() => parseSmokeConfig({ THANG_TENANT_TOKEN: "top-secret" })).toThrow(
      /APP_API_URL/,
    );
    try {
      parseSmokeConfig({ THANG_TENANT_TOKEN: "top-secret" });
    } catch (error) {
      expect(String(error)).not.toContain("top-secret");
    }
  });

  it("builds expected health, no-token, identity, mismatch, M2M, and replay checks", () => {
    const plan = buildSmokePlan(config());
    expect(plan.map((check) => check.name)).toEqual([
      "app health",
      "foundry health",
      "capture health",
      "office health",
      "app no-token rejection",
      "thang tenant app access",
      "thang platform Foundry access",
      "tramily Foundry denial",
      "tenant/org mismatch denial",
      "app M2M audience",
      "Foundry M2M audience",
      "webhook delivery",
      "webhook replay",
    ]);
    expect(plan.find((check) => check.name === "app no-token rejection").expectedStatus).toBe(401);
    expect(plan.find((check) => check.name === "app M2M audience").expectedAudience).not.toBe(
      plan.find((check) => check.name === "Foundry M2M audience").expectedAudience,
    );
  });

  it("passes status and verified claim metadata checks without decoding bearer tokens", async () => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/health/ready")) return response(200, { status: "ready" });
      if (url.includes("/webhook")) return response(calls.filter((call) => call.url.includes("/webhook")).length === 1 ? 202 : 202, { replayed: calls.filter((call) => call.url.includes("/webhook")).length > 1 });
      if (url.includes("foundry")) {
        if (options.headers?.authorization?.includes("tramily")) return response(403);
        if (options.headers?.authorization?.includes("foundry-m2m")) return response(200, { claimsVerified: { issuer: "https://clerk.example.test", audience: "foundry-service-machine" } });
        return response(200, { claimsVerified: { issuer: "https://clerk.example.test", audience: "family-platform-aud", role: "operator" } });
      }
      if (url.includes("other-tenant")) return response(403);
      if (!options.headers?.authorization) return response(401);
      if (options.headers.authorization.includes("app-m2m")) return response(200, { claimsVerified: { issuer: "https://clerk.example.test", audience: "app-api-machine" } });
      if (options.headers.authorization.includes("foundry-m2m")) return response(200, { claimsVerified: { issuer: "https://clerk.example.test", audience: "foundry-service-machine" } });
      return response(200, { claimsVerified: { issuer: "https://clerk.example.test", audience: "family-tenant-aud" } });
    };

    const result = await runSmokeTests(config({
      thangTenantToken: "thang-tenant",
      thangPlatformToken: "thang-platform",
      tramilyTenantToken: "tramily-tenant",
      appM2mToken: "app-m2m",
      foundryM2mToken: "foundry-m2m",
    }), { fetchImpl, logger: () => {} });

    expect(result.failed).toBe(0);
    expect(result.passed).toBe(13);
    expect(calls.every(({ options }) => !JSON.stringify(options).includes("secret"))).toBe(true);
  });

  it("redacts authorization values while preserving nonsecret headers", () => {
    expect(redactHeaders({ authorization: "Bearer secret", "content-type": "application/json" })).toEqual({
      authorization: "[REDACTED]",
      "content-type": "application/json",
    });
  });

  it("fails when endpoint returns unexpected status or claim metadata", async () => {
    const result = await runSmokeTests(config(), {
      fetchImpl: async () => response(200, { claimsVerified: { audience: "wrong" } }),
      logger: () => {},
    });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.errors.join(" ")).not.toContain("thang-tenant-secret");
  });
});
