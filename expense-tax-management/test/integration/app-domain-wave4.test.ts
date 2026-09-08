import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createExpenseDomain } from "../../services/app-api/src/domain/expenses.js";
import { DomainError } from "../../services/app-api/src/errors.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0J_WAVE4_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().slice(0, 8);

let postgresContainerId = "";
let runtimePassword = "";
let database: Kysely<AppDatabase>;

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
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

describe.skipIf(!integrationEnabled)("Phase 0J Wave 4 ledger queries", () => {
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
      config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    database = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5432/expense_tax_db`,
    );
  });

  afterAll(async () => {
    runSql(`DELETE FROM app.tenants WHERE slug LIKE 'wave4-${runKey}-%';`);
    runSql(`DELETE FROM app.users WHERE primary_email LIKE 'wave4-${runKey}-%';`);
    await database.destroy();
  });

  it("pages equal sort values with UUID tie-breakers and excludes archives", async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name)
      VALUES ('${userId}', 'wave4-${runKey}-owner@example.test', 'Owner');
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', 'Wave 4 Tenant', 'wave4-${runKey}-tenant');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
      VALUES ('${tenantId}', '${userId}', 'owner');
      INSERT INTO app.businesses
        (id, tenant_id, name, industry_code, timezone, base_currency)
      VALUES ('${businessId}', '${tenantId}', 'Ledger Business', 'restaurant', 'UTC', 'USD');
      INSERT INTO app.business_memberships
        (business_id, tenant_id, user_id, role)
      VALUES ('${businessId}', '${tenantId}', '${userId}', 'owner');
    `);
    const domain = createExpenseDomain(database);
    const requests = ["Alpha", "Beta", "Gamma"].map((merchant) =>
      domain.createBusiness({
        actorUserId: userId,
        tenantId,
        businessId,
        request: {
          businessId,
          merchant,
          amount: "10.00",
          currency: "USD",
          incurredOn: "2025-05-01",
        },
        requestId: `wave4-${runKey}-${merchant}`,
      }),
    );
    const [alpha, beta, gamma] = await Promise.all(requests);

    const first = await domain.listBusiness({
      actorUserId: userId,
      tenantId,
      businessId,
      query: { sort: "amount", direction: "asc", limit: 2 },
    });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await domain.listBusiness({
      actorUserId: userId,
      tenantId,
      businessId,
      query: {
        sort: "amount",
        direction: "asc",
        limit: 2,
        cursor: first.nextCursor!,
      },
    });
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
      new Set([alpha.id, beta.id, gamma.id]),
    );
    await expect(
      domain.listBusiness({
        actorUserId: userId,
        tenantId,
        businessId,
        query: {
          sort: "amount",
          direction: "desc",
          limit: 2,
          cursor: first.nextCursor!,
        },
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "VALIDATION_ERROR" });

    await domain.archiveBusiness({
      actorUserId: userId,
      tenantId,
      businessId,
      expenseId: gamma.id,
      request: { expectedVersion: 1 },
      requestId: `wave4-${runKey}-archive`,
    });
    const afterArchive = await domain.listBusiness({
      actorUserId: userId,
      tenantId,
      businessId,
      query: { sort: "amount", direction: "asc", limit: 100 },
    });
    expect(afterArchive.items.map((item) => item.id)).not.toContain(gamma.id);
  });
});
