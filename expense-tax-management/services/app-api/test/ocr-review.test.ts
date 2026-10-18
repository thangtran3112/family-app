import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import type { OcrReviewDomain } from "../src/domain/ocr-review.js";
import { assertLocalDockerEndpoint } from "../../../scripts/local-worker-smoke.mjs";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const BUSINESS_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID = "55555555-5555-4555-8555-555555555555";
const USER_ID = "66666666-6666-4666-8666-666666666666";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  APP_DATABASE_URL: "postgresql://runtime.invalid/app",
  TEMPORAL_HOST: "temporal.invalid:7233",
  TEMPORAL_NAMESPACE: "default",
  STORAGE_BACKEND: "local",
  LOCAL_STORAGE_DIR: "/tmp/expense-tax-ocr-review-test",
  STORAGE_LOCAL_BASE_URL: "https://storage.test",
  STORAGE_URL_SIGNING_KEY: "test-signing-key-not-secret",
  INBOUND_EMAIL_BASE_ADDRESS: "redacted",
  INBOUND_WEBHOOK_SIGNING_KEY: "test-webhook-key",
  INBOUND_ROUTING_TOKEN_SECRET: "test-routing-key",
  INBOUND_CHALLENGE_DIR: "/tmp/expense-tax-ocr-review-inbound",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  CLERK_APP_SERVICE_SUBJECT: "app-service-subject",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "foundry-service-subject",
};

const review = {
  schemaVersion: 1 as const,
  jobId: JOB_ID,
  fileId: FILE_ID,
  jobVersion: 4,
  fields: {
    merchant: "Acme",
    total: "42.50",
    currency: "USD",
    incurredOn: null,
    taxAmount: "0.00",
  },
  issues: ["date_missing" as const, "tax_zero_requires_confirmation" as const],
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:01:00.000Z",
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
    email: "redacted",
    emailVerified: true,
    displayName: "Owner",
  };
}

describe("OCR review routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const ocrReviewDomain: OcrReviewDomain = {
      listReviews: vi.fn(async () => ({ items: [review] })),
      getReview: vi.fn(async () => ({
        ...review,
        previewUrl: "https://storage.test/signed-preview",
        previewExpiresAt: "2026-10-18T00:16:00.000Z",
      })),
      completeReview: vi.fn(async () => ({
        statusCode: 200 as const,
        replayed: false,
        body: {
          schemaVersion: 1 as const,
          jobId: JOB_ID,
          expenseId: FILE_ID,
          jobVersion: 5,
          duplicateDecision: "no_match" as const,
          duplicateMatchIds: [],
        },
      })),
    };
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async () => tenantPrincipal()),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: { tenant: tenantVerifier, service: tenantVerifier },
      identityDomain: {
        provision: vi.fn(),
        resolve: vi.fn(async () => ({
          id: USER_ID,
          primaryEmail: "redacted",
          displayName: "Owner",
          status: "active" as const,
        })),
      },
      ocrReviewDomain,
    });
    apps.add(app);
    return { app, ocrReviewDomain };
  }

  it.each([
    ["personal", `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}`, { kind: "personal", profileId: PROFILE_ID }],
    ["business", `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}`, { kind: "business", businessId: BUSINESS_ID }],
  ] as const)("lists %s needs-input reviews", async (_label, base, scope) => {
    const { app, ocrReviewDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `${base}/ocr-reviews?status=needs_input`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [review] });
    expect(ocrReviewDomain.listReviews).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      scope,
    }));
  });

  it("returns a scoped review with a signed preview URL", async () => {
    const { app, ocrReviewDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/ocr-jobs/${JOB_ID}/review`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jobId: JOB_ID, previewUrl: "https://storage.test/signed-preview" });
    expect(ocrReviewDomain.getReview).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_ID }));
  });

  it("requires an idempotency key and forwards completion fields", async () => {
    const { app, ocrReviewDomain } = createTestApp();
    const url = `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/ocr-jobs/${JOB_ID}/complete`;
    const body = {
      expectedJobVersion: 4,
      merchant: "Acme",
      total: "42.50",
      currency: "USD",
      incurredOn: "2026-10-18",
      tax: { kind: "amount", amount: "5.53" },
    };

    const missingKey = await app.inject({
      method: "POST",
      url,
      headers: { authorization: "Bearer tenant-token" },
      payload: body,
    });
    expect(missingKey.statusCode).toBe(400);

    const response = await app.inject({
      method: "POST",
      url,
      headers: { authorization: "Bearer tenant-token", "idempotency-key": "complete-1" },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(ocrReviewDomain.completeReview).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: "business", businessId: BUSINESS_ID },
      jobId: JOB_ID,
      idempotencyKey: "complete-1",
      request: body,
    }));
  });

  it.each([
    ["merchant", { total: "42.50", currency: "USD", incurredOn: "2026-10-18", tax: { kind: "no_tax" } }],
    ["total", { merchant: "Acme", currency: "USD", incurredOn: "2026-10-18", tax: { kind: "no_tax" } }],
    ["currency", { merchant: "Acme", total: "42.50", incurredOn: "2026-10-18", tax: { kind: "no_tax" } }],
    ["date", { merchant: "Acme", total: "42.50", currency: "USD", tax: { kind: "no_tax" } }],
    ["tax", { merchant: "Acme", total: "42.50", currency: "USD", incurredOn: "2026-10-18" }],
    ["zero tax amount", { merchant: "Acme", total: "42.50", currency: "USD", incurredOn: "2026-10-18", tax: { kind: "amount", amount: "0.00" } }],
    ["negative tax", { merchant: "Acme", total: "42.50", currency: "USD", incurredOn: "2026-10-18", tax: { kind: "amount", amount: "-1.00" } }],
    ["tax above total", { merchant: "Acme", total: "42.50", currency: "USD", incurredOn: "2026-10-18", tax: { kind: "amount", amount: "42.51" } }],
  ])("rejects invalid completion input: %s", async (_label, fields) => {
    const { app, ocrReviewDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/ocr-jobs/${JOB_ID}/complete`,
      headers: { authorization: "Bearer tenant-token", "idempotency-key": "invalid-1" },
      payload: { expectedJobVersion: 4, ...fields },
    });

    expect(response.statusCode).toBe(400);
    expect(ocrReviewDomain.completeReview).not.toHaveBeenCalled();
  });

  it("accepts an explicit no-tax completion", async () => {
    const { app, ocrReviewDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/ocr-jobs/${JOB_ID}/complete`,
      headers: { authorization: "Bearer tenant-token", "idempotency-key": "no-tax-1" },
      payload: {
        expectedJobVersion: 4,
        merchant: "Acme",
        total: "42.50",
        currency: "USD",
        incurredOn: "2026-10-18",
        tax: { kind: "no_tax" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(ocrReviewDomain.completeReview).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ tax: { kind: "no_tax" } }),
    }));
  });
});

const integrationRequested = process.env.OCR_REVIEW_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");

function dockerPsql(containerId: string, databaseName: string, sqlText: string): string {
  return execFileSync("docker", [
    "exec",
    containerId,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "--username",
    "postgres",
    "--dbname",
    databaseName,
    "--tuples-only",
    "--no-align",
    "--pset",
    "footer=off",
    "--command",
    sqlText,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runAppApiContainer(
  environment: Record<string, string>,
  script: string,
): string {
  const args = ["run", "--rm", "-T", "--no-deps"];
  for (const key of Object.keys(environment)) args.push("-e", key);
  args.push(
    "app-api",
    "node",
    "--input-type=module",
    "--eval",
    script,
  );
  return execFileSync(composeScript, args, {
    cwd: repoRoot,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("OCR review real-PostgreSQL transport", () => {
  it("contains no host PostgreSQL connection path", async () => {
    const source = await fs.readFile(fileURLToPath(import.meta.url), "utf8");
    const forbidden = [
      ["EXPENSE", "TAX", "POSTGRES", "PORT"].join("_"),
      ["host:", '"local' + 'host"'].join(" "),
      ["127", "0", "0", "1"].join("."),
      ["54", "33"].join(""),
    ];
    for (const value of forbidden) expect(source).not.toContain(value);
    expect(source.indexOf("assertLocalDockerEndpoint();")).toBeGreaterThanOrEqual(0);
  });
});

describe.skipIf(!integrationRequested)("OCR review real PostgreSQL", () => {
  it("completes atomically, records evidence and deduplication, and fences concurrent writers", async () => {
    assertLocalDockerEndpoint();
    const postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!postgresContainerId) throw new Error("OCR review PostgreSQL prerequisites unavailable");
    const compose = JSON.parse(execFileSync(composeScript, ["config", "--format", "json"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })) as { services: Record<string, { environment?: Record<string, string | null> }> };
    const migratorPassword = compose.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
    const runtimePassword = compose.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    if (!migratorPassword || !runtimePassword) throw new Error("OCR review database roles unavailable");
    const databaseName = `expense_ocr_review_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const encodedMigratorPassword = encodeURIComponent(migratorPassword);
    const encodedRuntimePassword = encodeURIComponent(runtimePassword);
    const migrationUrl = `postgresql://expense_app_migrator:${encodedMigratorPassword}@postgres/${databaseName}`;
    const runtimeUrl = `postgresql://expense_app_runtime:${encodedRuntimePassword}@postgres/${databaseName}`;

    dockerPsql(postgresContainerId, "postgres", `CREATE DATABASE ${databaseName};`);
    try {
      dockerPsql(postgresContainerId, databaseName, `
        CREATE SCHEMA app AUTHORIZATION expense_app_migrator;
        CREATE SCHEMA app_migrations AUTHORIZATION expense_app_migrator;
        GRANT USAGE ON SCHEMA app TO expense_app_runtime;
      `);
      execFileSync("pnpm", ["--filter", "@expense-tax/contracts", "build"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("pnpm", ["--filter", "@expense-tax/app-api", "build"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync(composeScript, ["build", "app-api"], {
        cwd: repoRoot,
        env: process.env,
        stdio: "ignore",
      });
      runAppApiContainer({ APP_MIGRATION_DATABASE_URL: migrationUrl }, `
        import { runMigrations } from "./dist/database/migrate.js";
        await runMigrations(process.env.APP_MIGRATION_DATABASE_URL);
      `);
      dockerPsql(postgresContainerId, databaseName, `
        GRANT USAGE ON SCHEMA app TO expense_app_runtime;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO expense_app_runtime;
        GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app TO expense_app_runtime;
        REVOKE UPDATE, DELETE ON app.temporal_dispatch_routing FROM expense_app_runtime;
      `);
      dockerPsql(postgresContainerId, databaseName, `
        INSERT INTO app.users (id, primary_email, display_name) VALUES
          ('66666666-6666-4666-8666-666666666666', 'redacted', 'Owner'),
          ('77777777-7777-4777-8777-777777777777', 'redacted-two', 'Outsider');
        INSERT INTO app.tenants (id, name, slug, status)
          VALUES ('11111111-1111-4111-8111-111111111111', 'OCR Review', 'ocr-review', 'active');
        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status) VALUES
          ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-666666666666', 'owner', 'active'),
          ('11111111-1111-4111-8111-111111111111', '77777777-7777-4777-8777-777777777777', 'member', 'active');
        INSERT INTO app.personal_profiles (id, tenant_id, name)
          VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Personal');
        INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status)
          VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-666666666666', 'owner', 'active');

        INSERT INTO app.expenses (
          id, tenant_id, created_by_user_id, personal_profile_id, merchant, amount, tax_amount,
          currency, incurred_on, source, status
        ) VALUES (
          '88888888-8888-4888-8888-888888888888', '11111111-1111-4111-8111-111111111111',
          '66666666-6666-4666-8666-666666666666', '22222222-2222-4222-8222-222222222222',
          'Acme', 42.50, 5.53, 'USD', '2026-10-18', 'ocr', 'ready'
        );
        INSERT INTO app.expense_files (
          id, tenant_id, personal_profile_id, expense_id, original_filename, content_type,
          size_bytes, sha256_hex, storage_key, thumbnail_status, status
        ) VALUES (
          '99999999-9999-4999-8999-999999999999', '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222', '88888888-8888-4888-8888-888888888888',
          'existing.png', 'image/png', 10, repeat('a', 64), 'existing-key', 'skipped', 'READY'
        );

        INSERT INTO app.expense_files (
          id, tenant_id, personal_profile_id, original_filename, content_type, size_bytes,
          sha256_hex, storage_key, thumbnail_status, status
        ) VALUES
          ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'review-1.png', 'image/png', 10, repeat('a', 64), 'review-key-1', 'skipped', 'READY'),
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'review-2.png', 'image/png', 10, repeat('b', 64), 'review-key-2', 'skipped', 'READY'),
          ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'review-3.png', 'image/png', 10, repeat('c', 64), 'review-key-3', 'skipped', 'READY');

        INSERT INTO app.processing_jobs (
          id, tenant_id, personal_profile_id, workflow_type, workflow_id, task_queue,
          dispatch_generation, dispatch_namespace, run_id, status, target_aggregate_type,
          requested_by_user_id, source_file_id, input_params, allowed_result_schema_version,
          result, version, dispatched_at, completed_at
        ) VALUES
          ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'OcrReceiptWorkflow', 'job-review-1', 'expense-tax-processing', 1, 'default', 'run-review-1', 'SUCCEEDED', 'expense', '66666666-6666-4666-8666-666666666666', '55555555-5555-4555-8555-555555555555', '{"modeKey":"ocr_mode_balanced","reviewPolicy":"capture_required_fields_v1"}', 'capture-ocr-review-v1', '{"schemaVersion":1,"outcome":"needs_input","fields":{"merchant":"Acme","total":"42.50","currency":"USD","incurredOn":null,"taxAmount":"0.00"},"issues":["date_missing","tax_zero_requires_confirmation"]}', 4, now(), now()),
          ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'OcrReceiptWorkflow', 'job-review-2', 'expense-tax-processing', 1, 'default', 'run-review-2', 'SUCCEEDED', 'expense', '66666666-6666-4666-8666-666666666666', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"modeKey":"ocr_mode_balanced","reviewPolicy":"capture_required_fields_v1"}', 'capture-ocr-review-v1', '{"schemaVersion":1,"outcome":"needs_input","fields":{"merchant":null,"total":"20.00","currency":"USD","incurredOn":"2026-10-18","taxAmount":null},"issues":["merchant_missing","tax_missing"]}', 4, now(), now()),
          ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'OcrReceiptWorkflow', 'job-review-3', 'expense-tax-processing', 1, 'default', 'run-review-3', 'SUCCEEDED', 'expense', '66666666-6666-4666-8666-666666666666', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '{"modeKey":"ocr_mode_balanced","reviewPolicy":"capture_required_fields_v1"}', 'capture-ocr-review-v1', '{"schemaVersion":1,"outcome":"needs_input","fields":{"merchant":"Rollback","total":"30.00","currency":"USD","incurredOn":"2026-10-18","taxAmount":"3.00"},"issues":["tax_missing"]}', 4, now(), now());
      `);

      dockerPsql(postgresContainerId, databaseName, `
        CREATE FUNCTION app.reject_rollback_review_source() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.source_file_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' THEN
            RAISE EXCEPTION 'forced OCR review rollback';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_rollback_review_source
          BEFORE INSERT ON app.expense_sources
          FOR EACH ROW EXECUTE FUNCTION app.reject_rollback_review_source();
      `);

      const output = runAppApiContainer({ APP_DATABASE_URL: runtimeUrl }, `
        import { createAppDatabase } from "./dist/database/client.js";
        import { createOcrReviewDomain } from "./dist/domain/ocr-review.js";
        const database = createAppDatabase(process.env.APP_DATABASE_URL);
        const domain = createOcrReviewDomain(database, {
          filesDomain: {
            async issueFileReadUrl() {
              return { url: "https://storage.test/preview", expiresAt: "2026-10-18T01:00:00.000Z" };
            },
          },
        });
        const scope = { kind: "personal", profileId: "22222222-2222-4222-8222-222222222222" };
        const base = {
          actorUserId: "66666666-6666-4666-8666-666666666666",
          tenantId: "11111111-1111-4111-8111-111111111111",
          scope,
        };
        const listBefore = await domain.listReviews({ ...base, status: "needs_input" });
        const detail = await domain.getReview({ ...base, jobId: "44444444-4444-4444-8444-444444444444" });
        let outsiderCode = null;
        try {
          await domain.listReviews({ ...base, actorUserId: "77777777-7777-4777-8777-777777777777", status: "needs_input" });
        } catch (error) { outsiderCode = error.code; }
        let crossBusinessCode = null;
        try {
          await domain.listReviews({
            ...base,
            scope: { kind: "business", businessId: "33333333-3333-4333-8333-333333333333" },
            status: "needs_input",
          });
        } catch (error) { crossBusinessCode = error.code; }
        let crossTenantCode = null;
        try {
          await domain.listReviews({ ...base, tenantId: "ffffffff-ffff-4fff-8fff-ffffffffffff", status: "needs_input" });
        } catch (error) { crossTenantCode = error.code; }
        const request = {
          expectedJobVersion: 4,
          merchant: "Acme",
          total: "42.50",
          currency: "USD",
          incurredOn: "2026-10-18",
          tax: { kind: "amount", amount: "5.53" },
        };
        const first = await domain.completeReview({
          ...base, jobId: "44444444-4444-4444-8444-444444444444",
          request, idempotencyKey: "complete-1", requestId: "request-1",
        });
        const replay = await domain.completeReview({
          ...base, jobId: "44444444-4444-4444-8444-444444444444",
          request, idempotencyKey: "complete-1", requestId: "request-2",
        });
        let changedPayloadCode = null;
        try {
          await domain.completeReview({
            ...base, jobId: "44444444-4444-4444-8444-444444444444",
            request: { ...request, merchant: "Changed" }, idempotencyKey: "complete-1", requestId: "request-3",
          });
        } catch (error) { changedPayloadCode = error.code; }
        const secondJobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        const secondFileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const needsInputResult = {
          schemaVersion: 1,
          outcome: "needs_input",
          fields: { merchant: null, total: "20.00", currency: "USD", incurredOn: "2026-10-18", taxAmount: null },
          issues: ["merchant_missing", "tax_missing"],
        };
        async function resetSecond() {
          await database.updateTable("app.processing_jobs").set({
            status: "SUCCEEDED",
            allowed_result_schema_version: "capture-ocr-review-v1",
            input_params: { modeKey: "ocr_mode_balanced", reviewPolicy: "capture_required_fields_v1" },
            result: needsInputResult,
            version: 4,
            target_aggregate_id: null,
            run_id: "run-review-2",
            dispatched_at: new Date(),
            completed_at: new Date(),
          }).where("id", "=", secondJobId).execute();
          await database.updateTable("app.expense_files").set({
            status: "READY", expense_id: null,
          }).where("id", "=", secondFileId).execute();
        }
        async function rejectedCode(key, requestValue = request, jobId = secondJobId) {
          try {
            await domain.completeReview({
              ...base, jobId, request: requestValue, idempotencyKey: key, requestId: key,
            });
            return "accepted";
          } catch (error) { return error.code ?? error.name; }
        }
        const rejectionCodes = {};
        await resetSecond();
        await database.updateTable("app.processing_jobs").set({ allowed_result_schema_version: "ocr-extraction-v1" }).where("id", "=", secondJobId).execute();
        rejectionCodes.nonCapture = await rejectedCode("reject-non-capture");
        await resetSecond();
        await database.updateTable("app.processing_jobs").set({ result: { ...needsInputResult, outcome: "complete", fields: { merchant: "Second", total: "20.00", currency: "USD", incurredOn: "2026-10-18", taxAmount: "2.00" } } }).where("id", "=", secondJobId).execute();
        rejectionCodes.complete = await rejectedCode("reject-complete");
        await resetSecond();
        await database.updateTable("app.processing_jobs").set({ status: "FAILED" }).where("id", "=", secondJobId).execute();
        rejectionCodes.failed = await rejectedCode("reject-failed");
        await resetSecond();
        await database.updateTable("app.processing_jobs").set({
          status: "PENDING", run_id: null, dispatched_at: null, completed_at: null,
        }).where("id", "=", secondJobId).execute();
        rejectionCodes.pending = await rejectedCode("reject-pending");
        await resetSecond();
        await database.updateTable("app.expense_files").set({ status: "DELETED" }).where("id", "=", secondFileId).execute();
        rejectionCodes.deletedFile = await rejectedCode("reject-deleted");
        await resetSecond();
        await database.updateTable("app.expense_files").set({ expense_id: first.body.expenseId }).where("id", "=", secondFileId).execute();
        rejectionCodes.boundFile = await rejectedCode("reject-bound");
        await resetSecond();
        rejectionCodes.staleVersion = await rejectedCode("reject-stale", { ...request, expectedJobVersion: 3 });
        rejectionCodes.wrongJob = await rejectedCode("reject-job", request, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
        await resetSecond();
        const concurrent = await Promise.allSettled(["concurrent-a", "concurrent-b"].map((key) =>
          domain.completeReview({
            ...base, jobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            request: { ...request, merchant: "Second", total: "20.00", tax: { kind: "no_tax" } },
            idempotencyKey: key, requestId: key,
          }),
        ));
        let rollbackCode = null;
        try {
          await domain.completeReview({
            ...base, jobId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            request: { ...request, merchant: "Rollback", total: "30.00", tax: { kind: "amount", amount: "3.00" } },
            idempotencyKey: "rollback-1", requestId: "rollback-1",
          });
        } catch (error) { rollbackCode = error.code ?? error.name; }
        const expense = await database.selectFrom("app.expenses").select(["amount", "tax_amount"]).where("id", "=", first.body.expenseId).executeTakeFirstOrThrow();
        const file = await database.selectFrom("app.expense_files").select("expense_id").where("id", "=", "55555555-5555-4555-8555-555555555555").executeTakeFirstOrThrow();
        const job = await database.selectFrom("app.processing_jobs").select(["status", "target_aggregate_id", "version"]).where("id", "=", "44444444-4444-4444-8444-444444444444").executeTakeFirstOrThrow();
        const sourceCount = await database.selectFrom("app.expense_sources").select((eb) => eb.fn.countAll().as("count")).where("expense_id", "=", first.body.expenseId).executeTakeFirstOrThrow();
        const duplicateCount = await database.selectFrom("app.expense_duplicate_matches").select((eb) => eb.fn.countAll().as("count")).where("candidate_expense_id", "=", first.body.expenseId).executeTakeFirstOrThrow();
        const enrichmentCount = await database.selectFrom("app.processing_jobs").select((eb) => eb.fn.countAll().as("count")).where("workflow_type", "=", "ExpenseEnrichmentWorkflow").where("target_aggregate_id", "=", first.body.expenseId).executeTakeFirstOrThrow();
        const rollbackFile = await database.selectFrom("app.expense_files").select("expense_id").where("id", "=", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").executeTakeFirstOrThrow();
        const rollbackExpenseCount = await database.selectFrom("app.expenses").select((eb) => eb.fn.countAll().as("count")).where("merchant", "=", "Rollback").executeTakeFirstOrThrow();
        console.log(JSON.stringify({
          listCount: listBefore.items.length,
          detailPreview: detail.previewUrl,
          outsiderCode,
          crossBusinessCode,
          crossTenantCode,
          first: first.body,
          replayed: replay.replayed,
          replayExpenseId: replay.body.expenseId,
          changedPayloadCode,
          rejectionCodes,
          concurrent: concurrent.map((result) => result.status === "fulfilled"
            ? "fulfilled"
            : result.reason.code ?? result.reason.name),
          rollbackCode,
          expense,
          fileExpenseId: file.expense_id,
          job,
          sourceCount: Number(sourceCount.count),
          duplicateCount: Number(duplicateCount.count),
          enrichmentCount: Number(enrichmentCount.count),
          rollbackFileExpenseId: rollbackFile.expense_id,
          rollbackExpenseCount: Number(rollbackExpenseCount.count),
        }));
        await database.destroy();
      `);
      const result = JSON.parse(output) as Record<string, unknown>;
      expect(result).toMatchObject({
        listCount: 3,
        detailPreview: "https://storage.test/preview",
        outsiderCode: "NOT_FOUND",
        crossBusinessCode: "NOT_FOUND",
        crossTenantCode: "NOT_FOUND",
        replayed: true,
        changedPayloadCode: "CONFLICT",
        rejectionCodes: {
          nonCapture: "CONFLICT",
          complete: "CONFLICT",
          failed: "CONFLICT",
          pending: "CONFLICT",
          deletedFile: "NOT_FOUND",
          boundFile: "CONFLICT",
          staleVersion: "PRECONDITION_FAILED",
          wrongJob: "NOT_FOUND",
        },
        rollbackFileExpenseId: null,
        rollbackExpenseCount: 0,
      });
      expect(result.replayExpenseId).toBe((result.first as { expenseId: string }).expenseId);
      expect(result.concurrent).toEqual(expect.arrayContaining(["fulfilled", "CONFLICT"]));
      expect(result.expense).toMatchObject({ amount: "42.50", tax_amount: "5.53" });
      expect(result.fileExpenseId).toBe((result.first as { expenseId: string }).expenseId);
      expect(result.job).toMatchObject({ status: "SUCCEEDED", version: 5 });
      expect(result.sourceCount).toBe(1);
      expect(result.duplicateCount).toBeGreaterThan(0);
      expect(result.enrichmentCount).toBe(1);
    } finally {
      dockerPsql(postgresContainerId, "postgres", `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
    }
  }, 180_000);
});
