import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import {
  createDatabaseClerkIdentityMappingDomain,
  resolveTenantIdentityInTransaction,
} from "../../services/app-api/src/domain/clerk-identity.js";
import type { Kysely } from "kysely";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";

const integrationEnabled = process.env.PHASE_0J_INTEGRATION === "1";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().slice(0, 8);
const userId = randomUUID();
const tenantId = randomUUID();
const clerkUserId = `clerk-user-${runKey}`;
const clerkOrgId = `clerk-org-${runKey}`;

let postgresContainerId = "";
let runtimePassword = "";
let database: Kysely<AppDatabase>;

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

function runSql(statement: string) {
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
      statement,
    ],
    { encoding: "utf8" },
  );
}

function executeSql(statement: string): string {
  const result = runSql(statement);
  if (result.status !== 0) {
    throw new Error(result.stderr || `psql exited with status ${result.status}`);
  }
  return result.stdout.trim();
}

describe.skipIf(!integrationEnabled)("App Clerk identity PostgreSQL mapping", () => {
  beforeAll(() => {
    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      }),
    ) as ComposeConfig;
    postgresContainerId = execFileSync(
      composeScript,
      ["ps", "-q", "postgres"],
      { cwd: repoRoot, env: process.env, encoding: "utf8" },
    ).trim();
    runtimePassword =
      config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    if (!postgresContainerId || !runtimePassword) {
      throw new Error("PostgreSQL integration prerequisites are missing");
    }
    database = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
  });

  afterAll(async () => {
    if (postgresContainerId && runtimePassword) {
      runSql(`DELETE FROM app.tenants WHERE id = '${tenantId}';`);
      runSql(`DELETE FROM app.users WHERE id = '${userId}';`);
    }
    await database?.destroy();
  });

  it("has nullable unique Clerk mapping indexes", () => {
    expect(
      executeSql(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'app'
          AND indexname IN ('users_clerk_user_id_unique', 'tenants_clerk_org_id_unique')
        ORDER BY indexname;
      `),
    ).toBe("tenants_clerk_org_id_unique\nusers_clerk_user_id_unique");

    executeSql(`
      INSERT INTO app.users (id, clerk_user_id, primary_email, display_name)
      VALUES ('${userId}', '${clerkUserId}', 'clerk-${runKey}@example.test', 'Clerk User');
      INSERT INTO app.tenants (id, clerk_org_id, name, slug)
      VALUES ('${tenantId}', '${clerkOrgId}', 'Clerk Tenant', 'clerk-${runKey}');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
      VALUES ('${tenantId}', '${userId}', 'owner');
    `);
    expect(
      runSql(`
        INSERT INTO app.users (id, clerk_user_id, primary_email, display_name)
        VALUES ('${randomUUID()}', '${clerkUserId}', 'duplicate-${runKey}@example.test', 'Duplicate User');
      `).status,
    ).not.toBe(0);
    expect(
      runSql(`
        INSERT INTO app.tenants (id, clerk_org_id, name, slug)
        VALUES ('${randomUUID()}', '${clerkOrgId}', 'Duplicate Tenant', 'duplicate-${runKey}');
      `).status,
    ).not.toBe(0);
  });

  it("resolves only active mapped membership", async () => {
    const domain = createDatabaseClerkIdentityMappingDomain(database);

    await expect(
      domain.resolveTenantIdentity(clerkUserId, clerkOrgId),
    ).resolves.toMatchObject({
      status: "resolved",
      userId,
      tenantId,
      role: "owner",
    });

    await database.transaction().execute(async (transaction) => {
      await expect(
        resolveTenantIdentityInTransaction(
          transaction,
          clerkUserId,
          clerkOrgId,
        ),
      ).resolves.toMatchObject({
        status: "resolved",
        userId,
        tenantId,
        role: "owner",
      });
    });

    executeSql(`UPDATE app.tenants SET status = 'archived', archived_at = now() WHERE id = '${tenantId}';`);
    await expect(
      domain.resolveTenantIdentity(clerkUserId, clerkOrgId),
    ).resolves.toEqual({ status: "not_provisioned", reason: "org_deleted" });
  });
});
