import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createFilesDomain } from "../../services/app-api/src/domain/files.js";
import { createOcrJobsDomain } from "../../services/app-api/src/domain/ocr.js";
import { createPlansDomain } from "../../services/app-api/src/domain/plans.js";
import { createProcessingJobsDomain } from "../../services/app-api/src/domain/processing-jobs.js";
import type { TemporalWorkflowStarter } from "../../services/app-api/src/temporal/client.js";
import { DomainError } from "../../services/app-api/src/errors.js";
import { createLocalStorageAdapter } from "../../services/app-api/src/storage/local.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0C_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().slice(0, 8);

let postgresContainerId = "";
let runtimePassword = "";
let database: Kysely<AppDatabase>;
let storageRoot = "";

function runSql(sql: string) {
  return spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${runtimePassword}`,
      postgresContainerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      "127.0.0.1",
      "--username",
      "expense_app_runtime",
      "--dbname",
      "expense_tax_db",
      "--tuples-only",
      "--no-align",
      "--pset",
      "footer=off",
      "--command",
      sql,
    ],
    { encoding: "utf8" },
  );
}

function executeSql(sql: string): string {
  const result = runSql(sql);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function seedTenantWithProfile(): {
  userId: string;
  tenantId: string;
  profileId: string;
} {
  const userId = randomUUID();
  const tenantId = randomUUID();
  const profileId = randomUUID();
  executeSql(`
    INSERT INTO app.users (id, primary_email, display_name)
    VALUES ('${userId}', '0c-${runKey}-${userId.slice(0, 6)}@example.test', '0C User');
    INSERT INTO app.tenants (id, name, slug)
    VALUES ('${tenantId}', '0C Tenant', '0c-${runKey}-${tenantId.slice(0, 6)}');
    INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
    VALUES ('${tenantId}', '${userId}', 'owner');
    INSERT INTO app.personal_profiles (id, tenant_id, name)
    VALUES ('${profileId}', '${tenantId}', 'Personal');
    INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role)
    VALUES ('${profileId}', '${tenantId}', '${userId}', 'owner');
  `);
  return { userId, tenantId, profileId };
}

const TINY_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF",
  "utf8",
);

const EXTRACTION = {
  schemaVersion: 1,
  merchant: "Corner Deli",
  amount: "12.34",
  currency: "USD",
  incurredOn: "2026-09-09",
  confidence: 0.9,
};

const throwingStarter: TemporalWorkflowStarter = {
  start: () => {
    throw new Error("this test never dispatches for real");
  },
  close: async () => undefined,
};

function domains() {
  const storage = createLocalStorageAdapter({
    rootDir: storageRoot,
    baseUrl: "http://127.0.0.1:8100",
    signingKey: `0c-test-signing-${runKey}`,
  });
  const plansDomain = createPlansDomain(database);
  const filesDomain = createFilesDomain(database, storage);
  const processingJobsDomain = createProcessingJobsDomain(database, throwingStarter);
  const ocrJobsDomain = createOcrJobsDomain(database, { plansDomain, filesDomain });
  return { storage, plansDomain, filesDomain, processingJobsDomain, ocrJobsDomain };
}

async function createConfirmedPdfFile(
  tenant: { userId: string; tenantId: string; profileId: string },
  tag: string,
) {
  const { filesDomain } = domains();
  const created = await filesDomain.createUploadSession({
    actorUserId: tenant.userId,
    tenantId: tenant.tenantId,
    scope: { kind: "personal", profileId: tenant.profileId },
    request: { originalFilename: `${tag}.pdf`, contentType: "application/pdf" },
    idempotencyKey: `0c-${runKey}-${tag}-session`,
    requestId: `0c-${runKey}-${tag}-session`,
  });
  const fileRow = await database
    .selectFrom("app.expense_files")
    .selectAll()
    .where("id", "=", created.body.file.id)
    .executeTakeFirstOrThrow();
  await domains().storage.writeObject({
    storageKey: fileRow.storage_key,
    data: TINY_PDF,
    contentType: "application/pdf",
  });
  return filesDomain.confirmUploadSession({
    actorUserId: tenant.userId,
    tenantId: tenant.tenantId,
    scope: { kind: "personal", profileId: tenant.profileId },
    sessionId: created.body.uploadSession.id,
    requestId: `0c-${runKey}-${tag}-confirm`,
  });
}

function flipToDispatched(jobId: string): void {
  executeSql(`
    UPDATE app.processing_jobs
    SET status = 'DISPATCHED', run_id = 'fake-run', dispatched_at = now(), version = 2
    WHERE id = '${jobId}';
  `);
}

describe.skipIf(!integrationEnabled)("Phase 0C OCR jobs", () => {
  beforeAll(async () => {
    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as {
      readonly services: Record<
        string,
        { readonly environment?: Record<string, string | null> }
      >;
    };
    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    }).trim();
    runtimePassword =
      config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    if (!postgresContainerId || !runtimePassword) {
      throw new Error("Phase 0C PostgreSQL prerequisites are missing");
    }
    database = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5432/expense_tax_db`,
    );
    storageRoot = await mkdtemp(path.join(tmpdir(), `expense-tax-0c-${runKey}-`));
  });

  afterAll(async () => {
    if (postgresContainerId && runtimePassword) {
      executeSql(`DELETE FROM app.app_audit_events WHERE request_id LIKE '0c-${runKey}-%';`);
      executeSql(`DELETE FROM app.tenants WHERE slug LIKE '0c-${runKey}-%';`);
      executeSql(`DELETE FROM app.users WHERE primary_email LIKE '0c-${runKey}-%';`);
    }
    await database?.destroy();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it("creates an OCR job for an enabled mode and rejects a disabled one", async () => {
    const tenant = seedTenantWithProfile();
    const { ocrJobsDomain } = domains();
    const file = await createConfirmedPdfFile(tenant, "mode-gate");

    const created = await ocrJobsDomain.createOcrJob({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope: { kind: "personal", profileId: tenant.profileId },
      fileId: file.id,
      modeKey: "ocr_mode_fast",
      idempotencyKey: `0c-${runKey}-mode-fast`,
      requestId: `0c-${runKey}-mode-fast`,
    });
    expect(created.body.status).toBe("PENDING");
    expect(created.body.workflowType).toBe("OcrReceiptWorkflow");
    expect(created.body.targetAggregateType).toBe("expense");
    expect(created.body.targetAggregateId).toBeNull();
    expect(created.body.inputParams).toEqual({ modeKey: "ocr_mode_fast" });

    // ocr_mode_accurate is disabled on the trial plan.
    await expect(
      ocrJobsDomain.createOcrJob({
        actorUserId: tenant.userId,
        tenantId: tenant.tenantId,
        scope: { kind: "personal", profileId: tenant.profileId },
        fileId: file.id,
        modeKey: "ocr_mode_accurate",
        idempotencyKey: `0c-${runKey}-mode-accurate`,
        requestId: `0c-${runKey}-mode-accurate`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "FORBIDDEN" });
  });

  it("rejects OCR jobs for non-READY and already-bound files", async () => {
    const tenant = seedTenantWithProfile();
    const { filesDomain, ocrJobsDomain } = domains();

    const pending = await filesDomain.createUploadSession({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope: { kind: "personal", profileId: tenant.profileId },
      request: { originalFilename: "pending.pdf", contentType: "application/pdf" },
      idempotencyKey: `0c-${runKey}-pending-session`,
      requestId: `0c-${runKey}-pending-session`,
    });
    await expect(
      ocrJobsDomain.createOcrJob({
        actorUserId: tenant.userId,
        tenantId: tenant.tenantId,
        scope: { kind: "personal", profileId: tenant.profileId },
        fileId: pending.body.file.id,
        modeKey: "ocr_mode_fast",
        idempotencyKey: `0c-${runKey}-pending-job`,
        requestId: `0c-${runKey}-pending-job`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });

    const file = await createConfirmedPdfFile(tenant, "bound");
    const boundExpenseId = randomUUID();
    executeSql(`
      INSERT INTO app.expenses
        (id, tenant_id, created_by_user_id, personal_profile_id, merchant, amount, currency, incurred_on, source, status)
      VALUES
        ('${boundExpenseId}', '${tenant.tenantId}', '${tenant.userId}', '${tenant.profileId}', 'Prior', '1.00', 'USD', '2026-09-01', 'manual', 'draft');
      UPDATE app.expense_files SET expense_id = '${boundExpenseId}'
      WHERE id = '${file.id}';
    `);
    await expect(
      ocrJobsDomain.createOcrJob({
        actorUserId: tenant.userId,
        tenantId: tenant.tenantId,
        scope: { kind: "personal", profileId: tenant.profileId },
        fileId: file.id,
        modeKey: "ocr_mode_fast",
        idempotencyKey: `0c-${runKey}-bound-job`,
        requestId: `0c-${runKey}-bound-job`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
  });

  it("applies a SUCCEEDED extraction atomically: expense + file bind + job backfill", async () => {
    const tenant = seedTenantWithProfile();
    const { ocrJobsDomain, processingJobsDomain } = domains();
    const file = await createConfirmedPdfFile(tenant, "apply");

    const created = await ocrJobsDomain.createOcrJob({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope: { kind: "personal", profileId: tenant.profileId },
      fileId: file.id,
      modeKey: "ocr_mode_balanced",
      idempotencyKey: `0c-${runKey}-apply`,
      requestId: `0c-${runKey}-apply`,
    });
    flipToDispatched(created.body.id);
    const running = await processingJobsDomain.recordStatusUpdate({
      jobId: created.body.id,
      request: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: `${created.body.id}:status:running`,
        expectedJobVersion: 2,
      },
      actorServicePrincipal: "ai-worker",
      requestId: `0c-${runKey}-apply-running`,
    });
    expect(running.body.version).toBe(3);

    const submitted = await processingJobsDomain.submitResult({
      jobId: created.body.id,
      request: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: `${created.body.id}:ocr:result:succeeded`,
        expectedJobVersion: 3,
        resultSchemaVersion: "ocr-extraction-v1",
        result: EXTRACTION,
      },
      actorServicePrincipal: "ai-worker",
      requestId: `0c-${runKey}-apply-result`,
    });
    expect(submitted.body.status).toBe("SUCCEEDED");
    expect(submitted.body.targetAggregateId).not.toBeNull();

    const expense = await database
      .selectFrom("app.expenses")
      .selectAll()
      .where("id", "=", submitted.body.targetAggregateId as string)
      .executeTakeFirstOrThrow();
    expect(expense.merchant).toBe("Corner Deli");
    expect(expense.amount).toBe("12.34");
    expect(expense.currency).toBe("USD");
    expect(expense.source).toBe("ocr");
    expect(expense.status).toBe("ready");
    expect(expense.created_by_user_id).toBe(tenant.userId);
    expect(expense.personal_profile_id).toBe(tenant.profileId);

    expect(
      executeSql(
        `SELECT expense_id FROM app.expense_files WHERE id = '${file.id}';`,
      ),
    ).toBe(expense.id);

    // Idempotent replay: same key + same body replays without a second expense.
    const replay = await processingJobsDomain.submitResult({
      jobId: created.body.id,
      request: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: `${created.body.id}:ocr:result:succeeded`,
        expectedJobVersion: 3,
        resultSchemaVersion: "ocr-extraction-v1",
        result: EXTRACTION,
      },
      actorServicePrincipal: "ai-worker",
      requestId: `0c-${runKey}-apply-replay`,
    });
    expect(replay.replayed).toBe(true);
    expect(
      executeSql(
        `SELECT count(*) FROM app.expenses WHERE tenant_id = '${tenant.tenantId}';`,
      ),
    ).toBe("1");

    // A second job for the now-bound file is rejected at creation.
    await expect(
      ocrJobsDomain.createOcrJob({
        actorUserId: tenant.userId,
        tenantId: tenant.tenantId,
        scope: { kind: "personal", profileId: tenant.profileId },
        fileId: file.id,
        modeKey: "ocr_mode_fast",
        idempotencyKey: `0c-${runKey}-apply-second`,
        requestId: `0c-${runKey}-apply-second`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });

    // The file's job list surfaces the completed job to the tenant.
    const listed = await ocrJobsDomain.listOcrJobs({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope: { kind: "personal", profileId: tenant.profileId },
      fileId: file.id,
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.status).toBe("SUCCEEDED");
  });

  it("stores FAILED results without creating an expense", async () => {
    const tenant = seedTenantWithProfile();
    const { ocrJobsDomain, processingJobsDomain } = domains();
    const file = await createConfirmedPdfFile(tenant, "failed");

    const created = await ocrJobsDomain.createOcrJob({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope: { kind: "personal", profileId: tenant.profileId },
      fileId: file.id,
      modeKey: "ocr_mode_fast",
      idempotencyKey: `0c-${runKey}-failed`,
      requestId: `0c-${runKey}-failed`,
    });
    flipToDispatched(created.body.id);

    const submitted = await processingJobsDomain.submitResult({
      jobId: created.body.id,
      request: {
        schemaVersion: 1,
        status: "FAILED",
        idempotencyKey: `${created.body.id}:ocr:result:failed`,
        expectedJobVersion: 2,
        resultSchemaVersion: "ocr-extraction-v1",
        result: { error: "QUOTA_BLOCKED" },
      },
      actorServicePrincipal: "ai-worker",
      requestId: `0c-${runKey}-failed-result`,
    });
    expect(submitted.body.status).toBe("FAILED");
    expect(submitted.body.errorMessage).toBeNull();
    expect(submitted.body.targetAggregateId).toBeNull();
    expect(
      executeSql(
        `SELECT count(*) FROM app.expenses WHERE tenant_id = '${tenant.tenantId}';`,
      ),
    ).toBe("0");
    expect(
      executeSql(
        `SELECT expense_id FROM app.expense_files WHERE id = '${file.id}';`,
      ),
    ).toBe("");
  });

  it("rejects stale versions and wrong result schemas", async () => {
    const tenant = seedTenantWithProfile();
    const { ocrJobsDomain, processingJobsDomain } = domains();
    const file = await createConfirmedPdfFile(tenant, "stale");

    const created = await ocrJobsDomain.createOcrJob({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope: { kind: "personal", profileId: tenant.profileId },
      fileId: file.id,
      modeKey: "ocr_mode_fast",
      idempotencyKey: `0c-${runKey}-stale`,
      requestId: `0c-${runKey}-stale`,
    });
    flipToDispatched(created.body.id);

    await expect(
      processingJobsDomain.submitResult({
        jobId: created.body.id,
        request: {
          schemaVersion: 1,
          status: "SUCCEEDED",
          idempotencyKey: `${created.body.id}:ocr:result:stale`,
          expectedJobVersion: 999,
          resultSchemaVersion: "ocr-extraction-v1",
          result: EXTRACTION,
        },
        actorServicePrincipal: "ai-worker",
        requestId: `0c-${runKey}-stale-result`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "PRECONDITION_FAILED" });

    await expect(
      processingJobsDomain.submitResult({
        jobId: created.body.id,
        request: {
          schemaVersion: 1,
          status: "SUCCEEDED",
          idempotencyKey: `${created.body.id}:ocr:result:wrongschema`,
          expectedJobVersion: 2,
          resultSchemaVersion: "foundation-echo-v1",
          result: { echo: "x" },
        },
        actorServicePrincipal: "ai-worker",
        requestId: `0c-${runKey}-stale-schema`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "VALIDATION_ERROR" });
  });
});
