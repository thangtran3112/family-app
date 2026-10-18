import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createFoundryDatabase } from "../../services/foundry-service/src/database/client.js";
import type { FoundryDatabase } from "../../services/foundry-service/src/database/types.js";
import { syncEntitlementsFromOutbox } from "../../services/foundry-service/src/domain/entitlement-sync.js";
import { createQuotasDomain } from "../../services/foundry-service/src/domain/quotas.js";
import { DomainError } from "../../services/foundry-service/src/errors.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0K_WAVE_B_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().slice(0, 8);

let postgresContainerId = "";
let runtimePassword = "";
let database: Kysely<FoundryDatabase>;

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

function runSql(sql: string): CommandResult {
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
      "expense_foundry_runtime",
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

function seedAiModel(runSuffix: string): { connectionId: string; modelId: string } {
  const secretId = randomUUID();
  const connectionId = randomUUID();
  const modelId = randomUUID();
  executeSql(`
    INSERT INTO foundry.provider_secrets (id, value) VALUES ('${secretId}', 'sk-test');
    INSERT INTO foundry.provider_connections (id, key, provider_kind, display_name, secret_reference)
    VALUES ('${connectionId}', 'qb-${runSuffix}-conn', 'openai', 'Test', '${secretId}');
    INSERT INTO foundry.ai_models (id, provider_connection_id, provider_model_id, metered_model_key)
    VALUES ('${modelId}', '${connectionId}', 'model-${runSuffix}', 'metered-${runSuffix}');
  `);
  return { connectionId, modelId };
}

describe.skipIf(!integrationEnabled)("Phase 0K Wave B quotas and reservations", () => {
  beforeAll(() => {
    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as ComposeConfig;
    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    }).trim();
    runtimePassword =
      config.services.postgres?.environment?.FOUNDRY_RUNTIME_DB_PASSWORD ?? "";
    if (!postgresContainerId || !runtimePassword) {
      throw new Error("Phase 0K Wave B PostgreSQL prerequisites are missing");
    }
    database = createFoundryDatabase(
      `postgresql://expense_foundry_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
  });

  afterAll(async () => {
    if (!postgresContainerId || !runtimePassword) return;
    runSql(`DELETE FROM foundry.provider_connections WHERE key LIKE 'qb-${runKey}-%';`);
    runSql(`DELETE FROM foundry.service_metadata WHERE key = 'entitlement_sync_cursor';`);
    await database.destroy();
  });

  it("creates quota/reservation tables", () => {
    expect(
      executeSql(`
        SELECT string_agg(name, ',' ORDER BY name)
        FROM unnest(ARRAY[
          'foundry.tenant_ai_quotas',
          'foundry.ai_quota_periods',
          'foundry.ai_quota_reservations',
          'foundry.provider_call_logs',
          'foundry.ai_quota_reservation_resolutions'
        ]) AS name
        WHERE to_regclass(name) IS NOT NULL;
      `),
    ).toBe(
      "foundry.ai_quota_periods,foundry.ai_quota_reservation_resolutions,foundry.ai_quota_reservations,foundry.provider_call_logs,foundry.tenant_ai_quotas",
    );
  });

  it("enforces one aggregate policy per tenant/operation and idempotency uniqueness", () => {
    const { modelId } = seedAiModel(`${runKey}-uniq`);
    const tenantId = randomUUID();
    executeSql(`
      INSERT INTO foundry.tenant_ai_quotas (id, tenant_id, operation, ai_model_id, period_type, max_jobs)
      VALUES ('${randomUUID()}', '${tenantId}', 'AI_SEARCH', NULL, 'monthly', 20);
    `);
    const result = runSql(`
      INSERT INTO foundry.tenant_ai_quotas (id, tenant_id, operation, ai_model_id, period_type, max_jobs)
      VALUES ('${randomUUID()}', '${tenantId}', 'AI_SEARCH', NULL, 'monthly', 5);
    `);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("tenant_ai_quotas_aggregate_unique");

    // Same tenant/operation/idempotency key twice must collide.
    executeSql(`
      INSERT INTO foundry.ai_quota_reservations (id, tenant_id, operation, ai_model_id, idempotency_key)
      VALUES ('${randomUUID()}', '${tenantId}', 'AI_SEARCH', '${modelId}', 'job-uniq-1');
    `);
    const dup = runSql(`
      INSERT INTO foundry.ai_quota_reservations (id, tenant_id, operation, ai_model_id, idempotency_key)
      VALUES ('${randomUUID()}', '${tenantId}', 'AI_SEARCH', '${modelId}', 'job-uniq-1');
    `);
    expect(dup.status).not.toBe(0);
    expect(dup.stderr).toContain("ai_quota_reservations_idempotency_unique");
  });

  it("runs the full reserve -> call-started -> accepted -> CONSUMED lifecycle", async () => {
    const { modelId } = seedAiModel(`${runKey}-lifecycle`);
    const tenantId = randomUUID();
    const quotaId = randomUUID();
    executeSql(`
      INSERT INTO foundry.tenant_ai_quotas (id, tenant_id, operation, ai_model_id, period_type, max_jobs)
      VALUES ('${quotaId}', '${tenantId}', 'AI_SEARCH', NULL, 'monthly', 20);
    `);
    const domain = createQuotasDomain(database);

    const reservation = await domain.reserve({
      request: { tenantId, operation: "AI_SEARCH", aiModelId: modelId, idempotencyKey: "job-lifecycle-1" },
      requestId: `qb-${runKey}-reserve`,
    });
    expect(reservation.status).toBe("RESERVED");
    expect(
      executeSql(`
        SELECT concat(reserved_jobs, ',', consumed_jobs) FROM foundry.ai_quota_periods
        WHERE tenant_ai_quota_id = '${quotaId}';
      `),
    ).toBe("1,0");

    const started = await domain.recordCallAttempt({
      reservationId: reservation.id,
      request: {},
      requestId: `qb-${runKey}-call-started`,
    });
    expect(started.reservation.status).toBe("CALL_STARTED");
    expect(started.attemptNumber).toBe(1);

    const consumed = await domain.recordProviderOutcome({
      reservationId: reservation.id,
      attemptNumber: 1,
      request: { outcome: "accepted", latencyMs: 250, costUsd: "0.002500" },
      requestId: `qb-${runKey}-outcome`,
    });
    expect(consumed.status).toBe("CONSUMED");
    expect(
      executeSql(`
        SELECT concat(reserved_jobs, ',', consumed_jobs) FROM foundry.ai_quota_periods
        WHERE tenant_ai_quota_id = '${quotaId}';
      `),
    ).toBe("0,1");

    // A second accepted outcome on a NEW attempt after CONSUMED must not
    // double-consume (telemetry-only per design doc).
    await domain.recordCallAttempt({
      reservationId: reservation.id,
      request: {},
      requestId: `qb-${runKey}-extra-attempt`,
    });
    await domain.recordProviderOutcome({
      reservationId: reservation.id,
      attemptNumber: 2,
      request: { outcome: "accepted" },
      requestId: `qb-${runKey}-extra-outcome`,
    });
    expect(
      executeSql(`
        SELECT concat(reserved_jobs, ',', consumed_jobs) FROM foundry.ai_quota_periods
        WHERE tenant_ai_quota_id = '${quotaId}';
      `),
    ).toBe("0,1");
  });

  it("blocks on aggregate exhaustion even when a model-scoped policy has room", async () => {
    const { modelId } = seedAiModel(`${runKey}-exhaust`);
    const tenantId = randomUUID();
    executeSql(`
      INSERT INTO foundry.tenant_ai_quotas (id, tenant_id, operation, ai_model_id, period_type, max_jobs)
      VALUES ('${randomUUID()}', '${tenantId}', 'AI_SEARCH', NULL, 'monthly', 1);
      INSERT INTO foundry.tenant_ai_quotas (id, tenant_id, operation, ai_model_id, period_type, max_jobs)
      VALUES ('${randomUUID()}', '${tenantId}', 'AI_SEARCH', '${modelId}', 'monthly', 100);
    `);
    const domain = createQuotasDomain(database);

    await domain.reserve({
      request: { tenantId, operation: "AI_SEARCH", aiModelId: modelId, idempotencyKey: "job-exhaust-1" },
      requestId: `qb-${runKey}-exhaust-1`,
    });
    await expect(
      domain.reserve({
        request: { tenantId, operation: "AI_SEARCH", aiModelId: modelId, idempotencyKey: "job-exhaust-2" },
        requestId: `qb-${runKey}-exhaust-2`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
  });

  it("releases a RESERVED reservation and frees its slot", async () => {
    const { modelId } = seedAiModel(`${runKey}-release`);
    const tenantId = randomUUID();
    const quotaId = randomUUID();
    executeSql(`
      INSERT INTO foundry.tenant_ai_quotas (id, tenant_id, operation, ai_model_id, period_type, max_jobs)
      VALUES ('${quotaId}', '${tenantId}', 'AI_SEARCH', NULL, 'monthly', 1);
    `);
    const domain = createQuotasDomain(database);
    const reservation = await domain.reserve({
      request: { tenantId, operation: "AI_SEARCH", aiModelId: modelId, idempotencyKey: "job-release-1" },
      requestId: `qb-${runKey}-release-reserve`,
    });
    const released = await domain.release({
      reservationId: reservation.id,
      requestId: `qb-${runKey}-release`,
    });
    expect(released.status).toBe("RELEASED");
    expect(
      executeSql(
        `SELECT reserved_jobs FROM foundry.ai_quota_periods WHERE tenant_ai_quota_id = '${quotaId}';`,
      ),
    ).toBe("0");

    // Frees the slot for a fresh reservation under a different key.
    const second = await domain.reserve({
      request: { tenantId, operation: "AI_SEARCH", aiModelId: modelId, idempotencyKey: "job-release-2" },
      requestId: `qb-${runKey}-release-second`,
    });
    expect(second.status).toBe("RESERVED");
  });

  it("requires two different reconcilers to approve a released resolution, one suffices for consumed", async () => {
    const { modelId } = seedAiModel(`${runKey}-reconcile`);
    const tenantId = randomUUID();
    const quotaId = randomUUID();
    executeSql(`
      INSERT INTO foundry.tenant_ai_quotas (id, tenant_id, operation, ai_model_id, period_type, max_jobs)
      VALUES ('${quotaId}', '${tenantId}', 'AI_SEARCH', NULL, 'monthly', 20);
    `);
    const domain = createQuotasDomain(database);

    // Reservation A: resolved as 'released', needs two distinct approvers.
    const reservationA = await domain.reserve({
      request: { tenantId, operation: "AI_SEARCH", aiModelId: modelId, idempotencyKey: "job-reconcile-a" },
      requestId: `qb-${runKey}-reconcile-a-reserve`,
    });
    await domain.recordCallAttempt({
      reservationId: reservationA.id,
      request: {},
      requestId: `qb-${runKey}-reconcile-a-call`,
    });
    await domain.markReconciliationRequired({
      reservationId: reservationA.id,
      requestId: `qb-${runKey}-reconcile-a-required`,
    });

    const firstApproval = await domain.resolveReconciliation({
      reservationId: reservationA.id,
      resolvedBySubject: "reconciler-1",
      request: { decision: "released", reason: "provider confirmed no charge" },
      requestId: `qb-${runKey}-reconcile-a-approve-1`,
    });
    expect(firstApproval.status).toBe("RECONCILIATION_REQUIRED");

    await expect(
      domain.resolveReconciliation({
        reservationId: reservationA.id,
        resolvedBySubject: "reconciler-1",
        request: { decision: "released", reason: "duplicate attempt by same reconciler" },
        requestId: `qb-${runKey}-reconcile-a-dup`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });

    const secondApproval = await domain.resolveReconciliation({
      reservationId: reservationA.id,
      resolvedBySubject: "reconciler-2",
      request: { decision: "released", reason: "confirmed independently" },
      requestId: `qb-${runKey}-reconcile-a-approve-2`,
    });
    expect(secondApproval.status).toBe("RELEASED");

    // Reservation B: resolved as 'consumed', one approval suffices.
    const reservationB = await domain.reserve({
      request: { tenantId, operation: "AI_SEARCH", aiModelId: modelId, idempotencyKey: "job-reconcile-b" },
      requestId: `qb-${runKey}-reconcile-b-reserve`,
    });
    await domain.recordCallAttempt({
      reservationId: reservationB.id,
      request: {},
      requestId: `qb-${runKey}-reconcile-b-call`,
    });
    await domain.markReconciliationRequired({
      reservationId: reservationB.id,
      requestId: `qb-${runKey}-reconcile-b-required`,
    });
    const consumedResolution = await domain.resolveReconciliation({
      reservationId: reservationB.id,
      resolvedBySubject: "reconciler-1",
      request: { decision: "consumed", reason: "provider billing export confirms charge" },
      requestId: `qb-${runKey}-reconcile-b-approve`,
    });
    expect(consumedResolution.status).toBe("CONSUMED");

    expect(
      executeSql(
        `SELECT concat(reserved_jobs, ',', consumed_jobs) FROM foundry.ai_quota_periods WHERE tenant_ai_quota_id = '${quotaId}';`,
      ),
    ).toBe("0,1");
  });

  it("reports quota status and null policy as unavailable", async () => {
    const { modelId } = seedAiModel(`${runKey}-status`);
    const tenantId = randomUUID();
    executeSql(`
      INSERT INTO foundry.tenant_ai_quotas (id, tenant_id, operation, ai_model_id, period_type, max_jobs)
      VALUES ('${randomUUID()}', '${tenantId}', 'AI_SEARCH', NULL, 'monthly', 3);
    `);
    const domain = createQuotasDomain(database);
    await domain.reserve({
      request: { tenantId, operation: "AI_SEARCH", aiModelId: modelId, idempotencyKey: "job-status-1" },
      requestId: `qb-${runKey}-status-reserve`,
    });

    const status = await domain.getQuotaStatus({ tenantId, operation: "AI_SEARCH" });
    expect(status.isAvailable).toBe(true);
    expect(status.remainingJobs).toBe(2);
    expect(status.resetsAt).not.toBeNull();

    const noPolicy = await domain.getQuotaStatus({
      tenantId: randomUUID(),
      operation: "RECEIPT_OCR",
    });
    expect(noPolicy).toEqual({ isAvailable: false, remainingJobs: null, resetsAt: null });
  });

  describe("entitlement sync", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("syncs enabled and disabled entitlements, persists the cursor, and resumes from it", async () => {
      const tenantId = randomUUID();
      const fetchMock = vi.fn(async (input: Request) => {
        const url = new URL(input.url);
        expect(url.pathname).toBe("/internal/v1/entitlement-snapshots");
        expect(url.searchParams.get("afterSequence")).toBe("0");
        expect(input.headers.get("Authorization")).toBe("Bearer test-service-token");
        return new Response(
          JSON.stringify({
            items: [
              {
                tenantId,
                entitlementVersion: 2,
                entitlements: [
                  { featureKey: "ai_search", isEnabled: true, limitValue: 20, limitPeriod: "monthly", source: "plan" },
                  { featureKey: "receipt_forwarding", isEnabled: true, limitValue: null, limitPeriod: "unlimited", source: "plan" },
                ],
              },
            ],
            nextAfterSequence: 7,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await syncEntitlementsFromOutbox(database, {
        appApiBaseUrl: "https://app-api.test",
        appApiServiceToken: "test-service-token",
      });
      expect(result).toEqual({ syncedCount: 1, nextAfterSequence: 7 });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      expect(
        executeSql(`
          SELECT concat(period_type, ',', max_jobs) FROM foundry.tenant_ai_quotas
          WHERE tenant_id = '${tenantId}' AND operation = 'AI_SEARCH' AND ai_model_id IS NULL;
        `),
      ).toBe("monthly,20");

      // Second call must resume from the persisted cursor (7), not 0.
      vi.unstubAllGlobals();
      const secondFetchMock = vi.fn(async (input: Request) => {
        const url = new URL(input.url);
        expect(url.searchParams.get("afterSequence")).toBe("7");
        return new Response(
          JSON.stringify({
            items: [
              {
                tenantId,
                entitlementVersion: 3,
                entitlements: [
                  { featureKey: "ai_search", isEnabled: false, limitValue: 20, limitPeriod: "monthly", source: "override" },
                ],
              },
            ],
            nextAfterSequence: 9,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", secondFetchMock);
      const secondResult = await syncEntitlementsFromOutbox(database, {
        appApiBaseUrl: "https://app-api.test",
        appApiServiceToken: "test-service-token",
      });
      expect(secondResult.nextAfterSequence).toBe(9);
      // Disabled entitlement must hard-block (max_jobs=0), not skip.
      expect(
        executeSql(`
          SELECT max_jobs FROM foundry.tenant_ai_quotas
          WHERE tenant_id = '${tenantId}' AND operation = 'AI_SEARCH' AND ai_model_id IS NULL;
        `),
      ).toBe("0");
    });
  });
});
