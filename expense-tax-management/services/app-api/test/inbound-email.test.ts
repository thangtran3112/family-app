import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import type { InboundEmailDomain } from "../src/domain/inbound-email.js";
import {
  PatternMalwareScanner,
  attachmentMagicMatches,
  emailAuthAccepted,
  hmacHex,
  verifyWebhookSignature,
} from "../src/inbound/security.js";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/jwks",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/jwks",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  APP_DATABASE_URL: "postgresql://unused.test/app",
  TEMPORAL_HOST: "127.0.0.1:7233",
  TEMPORAL_NAMESPACE: "default",
  STORAGE_BACKEND: "local",
  LOCAL_STORAGE_DIR: "/tmp/inbound-test",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  STORAGE_URL_SIGNING_KEY: "storage-key",
  INBOUND_EMAIL_BASE_ADDRESS: "receipts@inbound.test",
  INBOUND_WEBHOOK_SIGNING_KEY: "webhook-key",
  INBOUND_ROUTING_TOKEN_SECRET: "routing-key",
  INBOUND_CHALLENGE_DIR: "/tmp/inbound-challenges-test",
};
const TENANT = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const SENDER = "33333333-3333-4333-8333-333333333333";
const INBOUND = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

function tenantPrincipal(): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject: "subject",
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.test",
    roles: [],
    scopes: [],
    tokenId: "token",
    email: "owner@example.test",
    emailVerified: true,
    displayName: "Owner",
  };
}

function inboundRow(status: "ACCEPTED" | "QUARANTINED" = "ACCEPTED") {
  return {
    id: INBOUND,
    tenantId: TENANT,
    personalProfileId: PROFILE,
    businessId: null,
    providerMessageId: "provider-1",
    senderEmail: "owner@example.test",
    recipientAddress: "receipts+abc@inbound.test",
    subject: "Receipt",
    status,
    quarantineReason: status === "QUARANTINED" ? ("EMAIL_AUTH_FAILED" as const) : null,
    attachmentCount: 1,
    totalBytes: 10,
    createdAt: "2026-09-09T00:00:00.000Z",
    processedAt: "2026-09-09T00:00:00.000Z",
  };
}

describe("inbound trust primitives", () => {
  it("verifies provider HMAC over exact bytes", () => {
    const body = Buffer.from('{"x":1}', "utf8");
    const signature = hmacHex("key", body);
    expect(verifyWebhookSignature("key", body, signature)).toBe(true);
    expect(verifyWebhookSignature("key", Buffer.from('{"x":2}'), signature)).toBe(false);
    expect(verifyWebhookSignature("key", body, "bad")).toBe(false);
  });

  it("accepts direct DMARC+SPF/DKIM or valid ARC", () => {
    expect(emailAuthAccepted({ spf: "pass", dkim: "none", dmarc: "pass", arc: "none" })).toBe(true);
    expect(emailAuthAccepted({ spf: "fail", dkim: "fail", dmarc: "fail", arc: "pass" })).toBe(true);
    expect(emailAuthAccepted({ spf: "pass", dkim: "pass", dmarc: "fail", arc: "none" })).toBe(false);
  });

  it("sniffs attachment magic and detects the EICAR test signature", async () => {
    expect(attachmentMagicMatches("application/pdf", Buffer.from("%PDF-1.4"))).toBe(true);
    expect(attachmentMagicMatches("application/pdf", Buffer.from("not pdf"))).toBe(false);
    const eicar = Buffer.from("%PDF-X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    expect((await PatternMalwareScanner.scan(eicar)).clean).toBe(false);
  });
});

describe("inbound routes", () => {
  function createTestApp() {
    const inboundEmailDomain: InboundEmailDomain = {
      createSender: vi.fn(async () => ({
        id: SENDER,
        tenantId: TENANT,
        personalProfileId: PROFILE,
        businessId: null,
        email: "owner@example.test",
        status: "pending",
        verifiedAt: null,
        createdAt: "2026-09-09T00:00:00.000Z",
      })),
      verifySender: vi.fn(),
      revokeSender: vi.fn(),
      listSenders: vi.fn(async () => []),
      rotateRoutingToken: vi.fn(async () => ({
        id: SENDER,
        tenantId: TENANT,
        personalProfileId: PROFILE,
        businessId: null,
        status: "active",
        routingAddress: "receipts+0123456789abcdef0123456789abcdef@inbound.test",
        createdAt: "2026-09-09T00:00:00.000Z",
        revokedAt: null,
      })),
      getRoutingToken: vi.fn(),
      listInboundEmails: vi.fn(async () => []),
      dismissInboundEmail: vi.fn(),
      handleWebhook: vi.fn(async () => ({
        inboundEmail: inboundRow(),
        createdFileIds: [],
        createdJobIds: [],
      })),
    };
    const tenantVerifier: TokenVerifier = { verify: vi.fn(async () => tenantPrincipal()) };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: tenantVerifier,
        service: { verify: vi.fn(async () => { throw new Error("unused"); }) },
      },
      identityDomain: {
        provision: vi.fn(),
        resolve: vi.fn(async () => ({
          id: USER,
          primaryEmail: "owner@example.test",
          displayName: "Owner",
          status: "active" as const,
        })),
      },
      inboundEmailDomain,
    });
    return { app, inboundEmailDomain };
  }

  it("creates a scoped sender through tenant auth", async () => {
    const { app, inboundEmailDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT}/personal-profiles/${PROFILE}/forwarding/verified-senders`,
      headers: { authorization: "Bearer tenant" },
      payload: { email: "Owner@Example.test" },
    });
    expect(response.statusCode).toBe(201);
    expect(inboundEmailDomain.createSender).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER,
        tenantId: TENANT,
        scope: { kind: "personal", profileId: PROFILE },
      }),
    );
    await app.close();
  });

  it("rejects forged webhook signatures before domain execution", async () => {
    const { app, inboundEmailDomain } = createTestApp();
    const body = Buffer.from("{}", "utf8");
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/inbound-email/provider-webhook",
      headers: {
        "content-type": "application/vnd.expense-tax.inbound+json",
        "x-inbound-signature": "0".repeat(64),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(401);
    expect(inboundEmailDomain.handleWebhook).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a correctly signed normalized webhook", async () => {
    const { app, inboundEmailDomain } = createTestApp();
    const payload = {
      providerMessageId: "provider-1",
      recipientAddress: "receipts+0123456789abcdef0123456789abcdef@inbound.test",
      senderEmail: "owner@example.test",
      receivedAt: "2026-09-09T00:00:00.000Z",
      auth: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
      attachments: [
        { filename: "r.pdf", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4").toString("base64") },
      ],
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/inbound-email/provider-webhook",
      headers: {
        "content-type": "application/vnd.expense-tax.inbound+json",
        "x-inbound-signature": hmacHex(TEST_ENV.INBOUND_WEBHOOK_SIGNING_KEY, body),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    expect(inboundEmailDomain.handleWebhook).toHaveBeenCalledOnce();
    await app.close();
  });
});
