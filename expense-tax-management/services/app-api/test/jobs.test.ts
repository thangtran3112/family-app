import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import type { ProcessingJobsDomain } from "../src/domain/processing-jobs.js";
import type { TemporalWorkflowStarter } from "../src/temporal/client.js";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
};

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

const JOB = {
  id: JOB_ID,
  tenantId: TENANT_ID,
  personalProfileId: PROFILE_ID,
  businessId: null,
  workflowType: "FoundationEchoWorkflow",
  workflowId: `job-${JOB_ID}`,
  taskQueue: "expense-tax-ai-worker",
  runId: null,
  status: "PENDING" as const,
  targetAggregateType: null,
  targetAggregateId: null,
  expectedAggregateVersion: null,
  inputParams: {},
  allowedResultSchemaVersion: "foundation-echo-v1",
  result: null,
  errorMessage: null,
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  dispatchedAt: null,
  completedAt: null,
};

function servicePrincipal(
  clientId: string,
  scopes: readonly string[],
): AuthPrincipal {
  return {
    tokenType: "service",
    subject: clientId === "ai-worker" ? "ai-worker-app-machine" : clientId,
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

describe("App API job routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const processingJobsDomain: ProcessingJobsDomain = {
      createJob: vi.fn(async () => JOB),
      dispatchPendingJobs: vi.fn(async () => ({ dispatchedCount: 0 })),
      recordStatusUpdate: vi.fn(async () => ({
        statusCode: 200 as const,
        body: { ...JOB, status: "RUNNING" as const, version: 2 },
        replayed: false,
      })),
      submitResult: vi.fn(async () => ({
        statusCode: 200 as const,
        body: { ...JOB, status: "SUCCEEDED" as const, version: 3 },
        replayed: false,
      })),
      getJob: vi.fn(async () => JOB),
    };
    const temporalStarter: TemporalWorkflowStarter = {
      start: vi.fn(async () => ({ runId: "fake-run-id" })),
      close: vi.fn(async () => undefined),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "platform-admin-token") {
          return servicePrincipal("platform-admin", ["jobs:manage"]);
        }
        if (token === "platform-admin-missing-scope-token") {
          return servicePrincipal("platform-admin", []);
        }
        if (token === "ai-worker-token") {
          return servicePrincipal("ai-worker", ["jobs:write"]);
        }
        if (token === "wrong-principal-token") {
          return servicePrincipal("ai-worker", ["jobs:manage"]);
        }
        throw new Error("wrong token");
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: { verify: vi.fn(async () => { throw new Error("no tenant tokens in this test"); }) },
        service: serviceVerifier,
      },
      processingJobsDomain,
      temporalStarter,
    });
    apps.add(app);
    return { app, processingJobsDomain, temporalStarter };
  }

  it("creates a foundation-echo job for an admin service principal", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/jobs/foundation-echo",
      headers: { authorization: "Bearer platform-admin-token" },
      payload: { tenantId: TENANT_ID, personalProfileId: PROFILE_ID },
    });

    expect(response.statusCode).toBe(201);
    expect(processingJobsDomain.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        scope: { personalProfileId: PROFILE_ID },
        workflowType: "FoundationEchoWorkflow",
        taskQueue: "expense-tax-ai-worker",
        actorServicePrincipal: "platform-admin",
      }),
    );
  });

  it("forbids a service token missing the jobs:manage scope from creating a job", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/jobs/foundation-echo",
      headers: { authorization: "Bearer platform-admin-missing-scope-token" },
      payload: { tenantId: TENANT_ID, personalProfileId: PROFILE_ID },
    });

    expect(response.statusCode).toBe(403);
    expect(processingJobsDomain.createJob).not.toHaveBeenCalled();
  });

  it("rejects a foundation-echo request with neither Personal nor business scope", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/jobs/foundation-echo",
      headers: { authorization: "Bearer platform-admin-token" },
      payload: { tenantId: TENANT_ID },
    });

    expect(response.statusCode).toBe(400);
    expect(processingJobsDomain.createJob).not.toHaveBeenCalled();
  });

  it("dispatches pending jobs only for the admin service principal", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/jobs/dispatch",
      headers: { authorization: "Bearer platform-admin-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ dispatchedCount: 0 });
    expect(processingJobsDomain.dispatchPendingJobs).toHaveBeenCalledOnce();
  });

  it("allows the ai-worker service principal to record a status update", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/status`,
      headers: { authorization: "Bearer ai-worker-token" },
      payload: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: "attempt-1",
        expectedJobVersion: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("RUNNING");
    expect(processingJobsDomain.recordStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        actorServicePrincipal: "ai-worker",
      }),
    );
  });

  it("forbids the platform-admin service principal (wrong scope shape) from recording a status update", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/status`,
      headers: { authorization: "Bearer platform-admin-token" },
      payload: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: "attempt-1",
        expectedJobVersion: 1,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(processingJobsDomain.recordStatusUpdate).not.toHaveBeenCalled();
  });

  it("forbids an ai-worker token that only carries the jobs:manage scope from writing a status update", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/status`,
      headers: { authorization: "Bearer wrong-principal-token" },
      payload: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: "attempt-1",
        expectedJobVersion: 1,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(processingJobsDomain.recordStatusUpdate).not.toHaveBeenCalled();
  });

  it("allows the ai-worker service principal to submit a result", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/result`,
      headers: { authorization: "Bearer ai-worker-token" },
      payload: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: "attempt-1",
        expectedJobVersion: 2,
        resultSchemaVersion: "foundation-echo-v1",
        result: { echo: JOB_ID },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("SUCCEEDED");
    expect(processingJobsDomain.submitResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID, actorServicePrincipal: "ai-worker" }),
    );
  });

  it("reads a job for the admin service principal", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}`,
      headers: { authorization: "Bearer platform-admin-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(JOB_ID);
    expect(processingJobsDomain.getJob).toHaveBeenCalledWith(JOB_ID);
  });
});
