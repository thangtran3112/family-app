import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import type { FilesDomain } from "../src/domain/files.js";
import { createContentSignature, toEpochSec } from "../src/storage/signing.js";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
  TEMPORAL_HOST: "127.0.0.1:7233",
  TEMPORAL_NAMESPACE: "default",
  STORAGE_BACKEND: "local",
  LOCAL_STORAGE_DIR: "/tmp/expense-tax-files-test",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  STORAGE_URL_SIGNING_KEY: "test-signing-key-not-secret",
};

const FILE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";
const ACTOR_USER_ID = "44444444-4444-4444-8444-444444444444";

const FILE = {
  id: FILE_ID,
  tenantId: TENANT_ID,
  personalProfileId: PROFILE_ID,
  businessId: null,
  expenseId: null,
  originalFilename: "receipt.jpg",
  contentType: "image/jpeg" as const,
  sizeBytes: null,
  sha256Hex: null,
  storageKey: `tenants/${TENANT_ID}/personal-${PROFILE_ID}/originals/${FILE_ID}/receipt.jpg`,
  thumbnailStorageKey: null,
  thumbnailStatus: "pending" as const,
  status: "PENDING" as const,
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function tenantPrincipal(): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject: "identity-subject",
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.test",
    roles: [],
    scopes: [],
    tokenId: "tenant-token-id",
    email: "owner@example.test",
    emailVerified: true,
    displayName: "Owner",
  };
}

function servicePrincipal(
  clientId: string,
  scopes: readonly string[],
): AuthPrincipal {
  return {
    tokenType: "service",
    subject: `${clientId}-subject`,
    clientId,
    audience: "expense-app-internal",
    issuer: "https://services.test",
    roles: [],
    scopes,
    tokenId: `${clientId}-token-id`,
    email: null,
    emailVerified: null,
    displayName: null,
  };
}

describe("App API file routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const filesDomain: FilesDomain = {
      createUploadSession: vi.fn(async () => ({
        statusCode: 201 as const,
        body: {
          file: FILE,
          uploadSession: {
            id: SESSION_ID,
            expenseFileId: FILE_ID,
            status: "PENDING" as const,
            expiresAt: TIMESTAMP,
            confirmedAt: null,
            createdAt: TIMESTAMP,
          },
          uploadTarget: {
            url: `http://127.0.0.1:8100/api/v1/file-content/${FILE_ID}?expires=1&signature=x`,
            method: "PUT" as const,
            requiredHeaders: { "Content-Type": "image/jpeg" },
            expiresAt: TIMESTAMP,
          },
        },
        replayed: false,
      })),
      confirmUploadSession: vi.fn(async () => ({ ...FILE, status: "READY" as const })),
      writePendingContent: vi.fn(async () => undefined),
      readReadyContent: vi.fn(async () => ({
        data: Buffer.from("bytes"),
        contentType: "image/jpeg",
      })),
      listFiles: vi.fn(async () => ({ items: [FILE], nextCursor: null })),
      getFile: vi.fn(async () => FILE),
      issueFileReadUrl: vi.fn(async () => ({
        url: "http://127.0.0.1:8100/api/v1/file-content/x",
        expiresAt: TIMESTAMP,
      })),
      issueWorkerReadUrl: vi.fn(async () => ({
        url: "http://127.0.0.1:8100/api/v1/file-content/x",
        expiresAt: TIMESTAMP,
      })),
      deleteFile: vi.fn(async () => undefined),
    };
    const resolve = vi.fn(async () => ({
      id: ACTOR_USER_ID,
      primaryEmail: "owner@example.test",
      displayName: "Owner",
      status: "active" as const,
    }));
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token !== "tenant-token") throw new Error("wrong token");
        return tenantPrincipal();
      }),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "ai-worker-token") {
          return servicePrincipal("ai-worker", ["files:read"]);
        }
        if (token === "platform-admin-token") {
          return servicePrincipal("platform-admin", ["jobs:manage"]);
        }
        throw new Error("wrong token");
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: { tenant: tenantVerifier, service: serviceVerifier },
      identityDomain: { provision: vi.fn(), resolve },
      filesDomain,
    });
    apps.add(app);
    return { app, filesDomain };
  }

  const collection = `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/files`;

  it("creates an upload session for an authenticated tenant user", async () => {
    const { app, filesDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `${collection}/upload-sessions`,
      headers: {
        authorization: "Bearer tenant-token",
        "idempotency-key": "session-1",
      },
      payload: { originalFilename: "receipt.jpg", contentType: "image/jpeg" },
    });

    expect(response.statusCode).toBe(201);
    expect(filesDomain.createUploadSession).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ACTOR_USER_ID,
        tenantId: TENANT_ID,
        scope: { kind: "personal", profileId: PROFILE_ID },
        idempotencyKey: "session-1",
      }),
    );
  });

  it("rejects a disallowed content type before touching the domain", async () => {
    const { app, filesDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `${collection}/upload-sessions`,
      headers: {
        authorization: "Bearer tenant-token",
        "idempotency-key": "session-1",
      },
      payload: { originalFilename: "receipt.exe", contentType: "application/x-msdownload" },
    });

    expect(response.statusCode).toBe(400);
    expect(filesDomain.createUploadSession).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated session creation", async () => {
    const { app, filesDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `${collection}/upload-sessions`,
      headers: { "idempotency-key": "session-1" },
      payload: { originalFilename: "receipt.jpg", contentType: "image/jpeg" },
    });

    expect(response.statusCode).toBe(401);
    expect(filesDomain.createUploadSession).not.toHaveBeenCalled();
  });

  it("confirms an upload session", async () => {
    const { app, filesDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `${collection}/upload-sessions/${SESSION_ID}/confirm`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("READY");
    expect(filesDomain.confirmUploadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
  });

  it("lists files with cursor pagination passthrough", async () => {
    const { app, filesDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `${collection}?limit=10`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(filesDomain.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    );
  });

  it("issues a worker read URL only for the ai-worker service principal", async () => {
    const { app, filesDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/files/${FILE_ID}/read-url`,
      headers: { authorization: "Bearer ai-worker-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(filesDomain.issueWorkerReadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: FILE_ID,
        actorServicePrincipal: "ai-worker",
      }),
    );
  });

  it("forbids other service principals from the worker read-url route", async () => {
    const { app, filesDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/files/${FILE_ID}/read-url`,
      headers: { authorization: "Bearer platform-admin-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(filesDomain.issueWorkerReadUrl).not.toHaveBeenCalled();
  });

  it("rejects tenant tokens on the worker read-url route", async () => {
    const { app, filesDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/files/${FILE_ID}/read-url`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(401);
    expect(filesDomain.issueWorkerReadUrl).not.toHaveBeenCalled();
  });

  it("rejects bearer-free content PUT with a forged signature before touching the domain", async () => {
    const { app, filesDomain } = createTestApp();
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/file-content/${FILE_ID}?expires=${toEpochSec(new Date(Date.now() + 60_000))}&signature=${"0".repeat(64)}`,
      headers: { "content-type": "image/jpeg" },
      payload: Buffer.from("bytes"),
    });

    expect(response.statusCode).toBe(403);
    expect(filesDomain.writePendingContent).not.toHaveBeenCalled();
  });

  it("accepts bearer-free content PUT with a valid signature", async () => {
    const { app, filesDomain } = createTestApp();
    const expiresEpochSec = toEpochSec(new Date(Date.now() + 60_000));
    const signature = createContentSignature({
      signingKey: TEST_ENV.STORAGE_URL_SIGNING_KEY,
      method: "PUT",
      fileId: FILE_ID,
      expiresEpochSec,
    });
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/file-content/${FILE_ID}?expires=${expiresEpochSec}&signature=${signature}`,
      headers: { "content-type": "image/jpeg" },
      payload: Buffer.from("bytes"),
    });

    expect(response.statusCode).toBe(204);
    expect(filesDomain.writePendingContent).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: FILE_ID }),
    );
  });

  it("rejects bearer-free content GET with an expired signature", async () => {
    const { app, filesDomain } = createTestApp();
    const expiresEpochSec = toEpochSec(new Date(Date.now() - 60_000));
    const signature = createContentSignature({
      signingKey: TEST_ENV.STORAGE_URL_SIGNING_KEY,
      method: "GET",
      fileId: FILE_ID,
      expiresEpochSec,
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/file-content/${FILE_ID}?expires=${expiresEpochSec}&signature=${signature}`,
    });

    expect(response.statusCode).toBe(410);
    expect(filesDomain.readReadyContent).not.toHaveBeenCalled();
  });

  it("deletes a file for an authenticated tenant user", async () => {
    const { app, filesDomain } = createTestApp();
    const response = await app.inject({
      method: "DELETE",
      url: `${collection}/${FILE_ID}`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(204);
    expect(filesDomain.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: FILE_ID }),
    );
  });
});
