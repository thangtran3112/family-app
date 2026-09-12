import { createHmac } from "node:crypto";
import net from "node:net";
import { Readable } from "node:stream";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { createAppConfig } from "../src/config.js";
import {
  createClerkWebhookHandler,
  type ClerkWebhookEvent,
  type ClerkWebhookMutation,
  type ClerkWebhookRepository,
} from "../src/integrations/clerk-webhooks.js";
import {
  verifyClerkWebhookSignature,
  parseClerkWebhookEvent,
} from "../src/integrations/clerk-webhook-signature.js";
import {
  CLERK_WEBHOOK_MAX_BODY_BYTES,
  registerClerkWebhookRoutes,
} from "../src/routes/clerk-webhooks.js";

const SECRET = "whsec_test-secret";
const EVENT_ID = "evt_test_123";
const USER_ID = "user_test_123";
const ORG_ID = "org_test_123";

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
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
  CLERK_WEBHOOK_SIGNING_SECRET: SECRET,
  APP_DATABASE_URL: "postgresql://unused.test/app",
  TEMPORAL_HOST: "127.0.0.1:7233",
  TEMPORAL_NAMESPACE: "default",
  STORAGE_BACKEND: "local",
  LOCAL_STORAGE_DIR: "/tmp/clerk-webhook-test",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  STORAGE_URL_SIGNING_KEY: "storage-key",
  INBOUND_EMAIL_BASE_ADDRESS: "receipts@inbound.test",
  INBOUND_WEBHOOK_SIGNING_KEY: "inbound-key",
  INBOUND_ROUTING_TOKEN_SECRET: "routing-key",
  INBOUND_CHALLENGE_DIR: "/tmp/inbound-challenges-test",
};

function signedHeaders(body: Buffer, timestamp = 1_800_000_000, eventId = EVENT_ID) {
  const content = `${eventId}.${timestamp}.${body.toString("utf8")}`;
  const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
    .update(content)
    .digest("base64");
  return {
    "svix-id": eventId,
    "svix-timestamp": String(timestamp),
    "svix-signature": `v1,${signature}`,
  };
}

function organizationEvent(type: "organization.created" | "organization.deleted", id = ORG_ID) {
  return { type, data: { id, name: "Family" } };
}

function membershipEvent(role: unknown = "org:member") {
  return {
    type: "organizationMembership.created",
    data: {
      organization: { id: ORG_ID },
      public_user_data: { user_id: USER_ID },
      role,
    },
  };
}

function userEvent(type: "user.created" | "user.updated" | "user.deleted" = "user.updated") {
  return {
    type,
    data: {
      id: USER_ID,
      first_name: "Ada",
      last_name: "Lovelace",
      email_addresses: [{ id: "email_1", email_address: "ada@example.test" }],
      primary_email_address_id: "email_1",
    },
  };
}

function exactLengthUserBody(length: number): Buffer {
  const prefix = Buffer.from(
    '{"type":"user.updated","data":{"id":"user_test_123","first_name":"Ada","last_name":"Lovelace","email_addresses":[{"id":"email_1","email_address":"ada@example.test"}],"primary_email_address_id":"email_1","padding":"',
  );
  const suffix = Buffer.from('"}}');
  return Buffer.concat([prefix, Buffer.alloc(length - prefix.length - suffix.length, 0x78), suffix]);
}

function repository(): ClerkWebhookRepository & {
  events: Set<string>;
  users: Map<string, { status: "active" | "disabled" }>;
  organizations: Map<string, { status: "active" | "archived" }>;
} {
  return {
    events: new Set(),
    users: new Map(),
    organizations: new Map(),
    async processEvent(event, operation) {
      if (this.events.has(event.id)) return { replayed: true };
      await operation({
        upsertUser: async () => {
          this.users.set(USER_ID, { status: "active" });
        },
        markUserDeleted: async () => {
          this.users.set(USER_ID, { status: "disabled" });
        },
        upsertOrganization: async () => {
          this.organizations.set(ORG_ID, { status: "active" });
        },
        markOrganizationDeleted: async () => {
          this.organizations.set(ORG_ID, { status: "archived" });
        },
        upsertMembership: vi.fn(),
        markMembershipDeleted: vi.fn(),
      });
      this.events.add(event.id);
      return { replayed: false };
    },
  };
}

describe("Clerk webhook signatures", () => {
  it("verifies deterministic Svix v1 signatures over exact raw bytes", () => {
    const body = Buffer.from('{"type":"user.updated"}', "utf8");
    const headers = signedHeaders(body);
    expect(verifyClerkWebhookSignature(SECRET, body, headers, 1_800_000_100)).toBe(true);
    expect(
      verifyClerkWebhookSignature(SECRET, Buffer.from('{"type":"user.created"}'), headers, 1_800_000_100),
    ).toBe(false);
  });

  it("rejects stale, malformed, and unknown event payloads", () => {
    const body = Buffer.from(JSON.stringify(userEvent()), "utf8");
    expect(verifyClerkWebhookSignature(SECRET, body, signedHeaders(body), 1_800_001_000)).toBe(false);
    expect(() => parseClerkWebhookEvent(EVENT_ID, "unknown.event", {})).toThrow();
    expect(() => parseClerkWebhookEvent(EVENT_ID, "user.updated", null)).toThrow();
    expect(() => parseClerkWebhookEvent("x".repeat(256), "user.updated", userEvent().data)).toThrow();
  });
});

describe("Clerk webhook route and processing", () => {
  it("accepts valid events, replays them idempotently, and marks deletion without financial deletion", async () => {
    const store = repository();
    const handler = createClerkWebhookHandler(store);
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      clerkWebhookHandler: handler,
    });
    const body = Buffer.from(JSON.stringify(userEvent()), "utf8");
    const headers = signedHeaders(body, Math.floor(Date.now() / 1000));

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/clerk/webhook",
      headers: { ...headers, "content-type": "application/json" },
      payload: body,
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/clerk/webhook",
      headers: { ...headers, "content-type": "application/json" },
      payload: body,
    });

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ accepted: true, replayed: true });

    const deletedBody = Buffer.from(JSON.stringify(userEvent("user.deleted")), "utf8");
    const deletedHeaders = signedHeaders(deletedBody, Math.floor(Date.now() / 1000), "evt_test_deleted");
    const deleted = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/clerk/webhook",
      headers: { ...deletedHeaders, "content-type": "application/json" },
      payload: deletedBody,
    });
    expect(deleted.statusCode).toBe(202);
    expect(store.users.get(USER_ID)).toEqual({ status: "disabled" });
    await app.close();
  });

  it("rejects invalid signature and malformed JSON before repository execution", async () => {
    const store = repository();
    const handler = createClerkWebhookHandler(store);
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      clerkWebhookHandler: handler,
    });
    const body = Buffer.from("not-json", "utf8");
    const headers = signedHeaders(body, Math.floor(Date.now() / 1000));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/clerk/webhook",
      headers: { ...headers, "content-type": "application/json" },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(store.events.size).toBe(0);
    await app.close();
  });

  it.each([
    ["missing primary email", { type: "user.updated", data: { id: USER_ID, email_addresses: [] } }],
    ["unknown membership role", membershipEvent("org:superuser")],
    ["empty organization delete ID", organizationEvent("organization.deleted", "")],
  ])("rejects %s without claiming event", async (_label, payload) => {
    const store = repository();
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      clerkWebhookHandler: createClerkWebhookHandler(store),
    });
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const headers = signedHeaders(body, Math.floor(Date.now() / 1000), `evt_invalid_${String(_label).replaceAll(" ", "_")}`);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/clerk/webhook",
      headers: { ...headers, "content-type": "application/json" },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(store.events.size).toBe(0);
    await app.close();
  });

  it("rejects an oversized signed event ID before repository execution", async () => {
    const store = repository();
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      clerkWebhookHandler: createClerkWebhookHandler(store),
    });
    const body = Buffer.from(JSON.stringify(userEvent()), "utf8");
    const eventId = "e".repeat(256);
    const headers = signedHeaders(body, Math.floor(Date.now() / 1000), eventId);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/clerk/webhook",
      headers: { ...headers, "content-type": "application/json" },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(store.events.size).toBe(0);
    await app.close();
  });

  it("accepts a body exactly at the raw-body limit", async () => {
    const verifySignature = vi.fn(() => true);
    const handler = vi.fn(async () => ({ replayed: false }));
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      clerkWebhookHandler: { handle: handler },
      clerkWebhookVerifySignature: verifySignature,
    });
    const body = exactLengthUserBody(CLERK_WEBHOOK_MAX_BODY_BYTES);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/clerk/webhook",
      headers: { ...signedHeaders(body, Math.floor(Date.now() / 1000)), "content-type": "application/json" },
      payload: body,
    });

    expect(response.statusCode).toBe(202);
    expect(verifySignature).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects an oversized body before signature verification or handler execution", async () => {
    const verifySignature = vi.fn(() => true);
    const handler = vi.fn(async () => ({ replayed: false }));
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      clerkWebhookHandler: { handle: handler },
      clerkWebhookVerifySignature: verifySignature,
    });
    const body = Buffer.concat([exactLengthUserBody(CLERK_WEBHOOK_MAX_BODY_BYTES), Buffer.from("x")]);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/clerk/webhook",
      headers: { ...signedHeaders(body, Math.floor(Date.now() / 1000)), "content-type": "application/json" },
      payload: body,
    });

    expect(response.statusCode).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 413 over TCP without resetting an oversized Content-Length request", async () => {
    const verifySignature = vi.fn(() => true);
    const handler = vi.fn(async () => ({ replayed: false }));
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      clerkWebhookHandler: { handle: handler },
      clerkWebhookVerifySignature: verifySignature,
    });

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("test server did not expose TCP address");
      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port: address.port });
        let received = "";
        const body = Buffer.alloc(CLERK_WEBHOOK_MAX_BODY_BYTES + 1, 0x78);
        socket.setTimeout(5_000, () => {
          socket.destroy();
          reject(new Error("timed out waiting for oversized webhook response"));
        });
        socket.on("data", (chunk) => {
          received += chunk.toString("latin1");
        });
        socket.on("error", reject);
        socket.on("close", (hadError) => {
          if (hadError) reject(new Error("oversized webhook socket closed with an error"));
          else resolve(received);
        });
        socket.on("connect", () => {
          socket.write([
            "POST /api/v1/integrations/clerk/webhook HTTP/1.1",
            "Host: 127.0.0.1",
            "Content-Type: application/json",
            `Content-Length: ${CLERK_WEBHOOK_MAX_BODY_BYTES + 1}`,
            "Connection: close",
            "",
            "",
          ].join("\r\n"));
          socket.cork();
          for (let offset = 0; offset < body.length; offset += 64 * 1024) {
            socket.write(body.subarray(offset, Math.min(offset + 64 * 1024, body.length)));
          }
          socket.uncork();
          socket.end();
        });
      });

      expect(response).toMatch(/^HTTP\/1\.1 413 /);
      expect(verifySignature).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("drains an oversized content-length stream without masking 413", async () => {
    const app = Fastify({ logger: false });
    let preParsing;
    app.addHook("onRoute", (route) => {
      if (route.url === "/api/v1/integrations/clerk/webhook") preParsing = route.preParsing;
    });
    await registerClerkWebhookRoutes(app, {
      signingSecret: SECRET,
      handler: { handle: vi.fn(async () => ({ replayed: false })) },
    });
    expect(preParsing).toBeTypeOf("function");
    const payload = Readable.from([Buffer.from("not-consumed")]);
    const resume = vi.spyOn(payload, "resume");
    resume.mockImplementation(() => {
      throw new Error("resume failed");
    });

    await expect(
      preParsing(
        { headers: { "content-length": String(CLERK_WEBHOOK_MAX_BODY_BYTES + 1) } },
        {},
        payload,
      ),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(resume).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects chunked bodies once accumulated bytes exceed the limit", async () => {
    const handler = vi.fn(async () => ({ replayed: false }));
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      clerkWebhookHandler: { handle: handler },
    });
    const body = Buffer.concat([exactLengthUserBody(CLERK_WEBHOOK_MAX_BODY_BYTES), Buffer.from("x")]);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/clerk/webhook",
      headers: { "content-type": "application/json" },
      payload: Readable.from([body.subarray(0, CLERK_WEBHOOK_MAX_BODY_BYTES), body.subarray(CLERK_WEBHOOK_MAX_BODY_BYTES)]),
    });

    expect(response.statusCode).toBe(413);
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it("leaves out-of-order membership event unclaimed so retry succeeds after mappings arrive", async () => {
    const claimed = new Set<string>();
    let mappingsReady = false;
    let membershipApplied = false;
    const repository: ClerkWebhookRepository = {
      async processEvent(event, operation) {
        if (claimed.has(event.id)) return { replayed: true };
        await operation({
          upsertUser: vi.fn(),
          markUserDeleted: vi.fn(),
          upsertOrganization: vi.fn(),
          markOrganizationDeleted: vi.fn(),
          upsertMembership: async () => {
            if (!mappingsReady) throw new Error("mapping missing");
            membershipApplied = true;
          },
          markMembershipDeleted: vi.fn(),
        });
        claimed.add(event.id);
        return { replayed: false };
      },
    };
    const handler = createClerkWebhookHandler(repository);
    const event = { id: "evt_membership_retry", ...membershipEvent() } as ClerkWebhookEvent;

    await expect(handler.handle(event)).rejects.toThrow("mapping missing");
    expect(claimed.has(event.id)).toBe(false);
    mappingsReady = true;
    await expect(handler.handle(event)).resolves.toEqual({ replayed: false });
    expect(membershipApplied).toBe(true);
  });

  it("dispatches organization membership events through injected repository", async () => {
    const processEvent = vi.fn(async (_event: ClerkWebhookEvent, operation: (mutation: ClerkWebhookMutation) => Promise<void>) => {
      await operation({
        upsertUser: vi.fn(),
        markUserDeleted: vi.fn(),
        upsertOrganization: vi.fn(),
        markOrganizationDeleted: vi.fn(),
        upsertMembership: vi.fn(),
        markMembershipDeleted: vi.fn(),
      });
      return { replayed: false };
    });
    const handler = createClerkWebhookHandler({ processEvent });
    await handler.handle({
      id: EVENT_ID,
      type: "organizationMembership.created",
      data: {
        organization: { id: ORG_ID },
        public_user_data: { user_id: USER_ID },
        role: "org:admin",
      },
    });
    expect(processEvent).toHaveBeenCalledOnce();
  });

  it("rejects unknown user and organization webhook identities", async () => {
    const handler = createClerkWebhookHandler({
      async processEvent(_event, operation) {
        await operation({
          upsertUser: async () => {
            throw new Error("Clerk user is not pre-provisioned");
          },
          markUserDeleted: vi.fn(),
          upsertOrganization: async () => {
            throw new Error("Clerk organization is not pre-provisioned");
          },
          markOrganizationDeleted: vi.fn(),
          upsertMembership: vi.fn(),
          markMembershipDeleted: vi.fn(),
        });
        return { replayed: false };
      },
    });

    await expect(
      handler.handle({ id: "evt_unknown_user", ...userEvent("user.created") }),
    ).rejects.toThrow("not pre-provisioned");
  });
});
