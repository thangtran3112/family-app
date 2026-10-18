import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FileMigrationProvider, Migrator } from "kysely/migration";
import { Kysely, PostgresDialect, sql, type Migration } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppDatabase } from "../src/database/types.js";
import { createExpenseDomain } from "../src/domain/expenses.js";

const requested = process.env.EXPENSE_TAX_AMOUNT_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/database/migrations",
);
const postgresPort = Number(process.env.EXPENSE_TAX_POSTGRES_PORT ?? "5433");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_amount_${runKey}`;

const USER_ID = "22000000-0000-4000-8000-000000000001";
const TENANT_ID = "22000000-0000-4000-8000-000000000002";
const PROFILE_ID = "22000000-0000-4000-8000-000000000003";
const HISTORICAL_EXPENSE_ID = "22000000-0000-4000-8000-000000000004";
const STORED_EXPENSE_ID = "22000000-0000-4000-8000-000000000005";

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase> | undefined;
let migratorDatabase: Kysely<unknown> | undefined;

function dockerPsql(dbName: string, sqlText: string): string {
  const result = spawnSync(
    "docker",
    [
      "exec",
      postgresContainerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--username",
      "postgres",
      "--dbname",
      dbName,
      "--tuples-only",
      "--no-align",
      "--pset",
      "footer=off",
      "--command",
      sqlText,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function adminSql(sqlText: string, dbName = "postgres"): string {
  return dockerPsql(dbName, sqlText);
}

describe.skipIf(!requested)("migration 022 and expense tax amount domain", () => {
  beforeAll(async () => {
    if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
      throw new Error("Expense tax amount PostgreSQL prerequisites unavailable");
    }
    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    }).trim();
    if (!postgresContainerId) {
      throw new Error("Expense tax amount PostgreSQL prerequisites unavailable");
    }

    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      }),
    ) as ComposeConfig;
    runtimePassword = config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    migratorPassword = config.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
    if (!runtimePassword || !migratorPassword) {
      throw new Error("Expense tax amount PostgreSQL prerequisites unavailable");
    }

    const quoteLiteral = (value: string) => value.replaceAll("'", "''");
    adminSql(`
      ALTER ROLE expense_app_migrator PASSWORD '${quoteLiteral(migratorPassword)}';
      ALTER ROLE expense_app_runtime PASSWORD '${quoteLiteral(runtimePassword)}';
    `);

    adminSql(`CREATE DATABASE ${databaseName};`);
    adminSql(
      `CREATE SCHEMA app AUTHORIZATION expense_app_migrator;
       CREATE SCHEMA app_migrations AUTHORIZATION expense_app_migrator;`,
      databaseName,
    );

    migratorDatabase = new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: new Pool({
          host: "localhost",
          port: postgresPort,
          user: "expense_app_migrator",
          password: migratorPassword,
          database: databaseName,
        }),
      }),
    });
    const fileProvider = new FileMigrationProvider({ fs, path, migrationFolder: migrationsFolder });
    const migrations = await fileProvider.getMigrations();
    const taxAmountMigration = migrations["022_expense_tax_amount"] as Migration | undefined;
    const through021 = Object.fromEntries(
      Object.entries(migrations).filter(([name]) => name !== "022_expense_tax_amount"),
    );
    const migrator = new Migrator({
      db: migratorDatabase,
      migrationTableSchema: "app_migrations",
      provider: { getMigrations: async () => through021 },
    });
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;

    await sql`INSERT INTO app.users (id, primary_email, display_name)
      VALUES (${USER_ID}, '', 'Tax Amount Owner')`.execute(migratorDatabase);
    await sql`INSERT INTO app.tenants (id, name, slug, status)
      VALUES (${TENANT_ID}, 'Tax Amount Tenant', ${`tax-amount-${runKey}`}, 'active')`.execute(migratorDatabase);
    await sql`INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
      VALUES (${TENANT_ID}, ${USER_ID}, 'owner', 'active')`.execute(migratorDatabase);
    await sql`INSERT INTO app.personal_profiles (id, tenant_id, name)
      VALUES (${PROFILE_ID}, ${TENANT_ID}, 'Tax Amount Profile')`.execute(migratorDatabase);
    await sql`INSERT INTO app.personal_memberships
      (personal_profile_id, tenant_id, user_id, role, status)
      VALUES (${PROFILE_ID}, ${TENANT_ID}, ${USER_ID}, 'owner', 'active')`.execute(migratorDatabase);
    await sql`INSERT INTO app.expenses
      (id, tenant_id, created_by_user_id, personal_profile_id, merchant, amount, currency, incurred_on)
      VALUES (${HISTORICAL_EXPENSE_ID}, ${TENANT_ID}, ${USER_ID}, ${PROFILE_ID}, 'Historical', 10.00, 'USD', '2026-01-01')`.execute(migratorDatabase);

    expect(taxAmountMigration).toBeDefined();
    await taxAmountMigration!.up(migratorDatabase);
    adminSql(
      `GRANT USAGE ON SCHEMA app TO expense_app_runtime;
       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO expense_app_runtime;
       GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app TO expense_app_runtime;`,
      databaseName,
    );
    database = new Kysely<AppDatabase>({
      dialect: new PostgresDialect({
        pool: new Pool({
          host: "localhost",
          port: postgresPort,
          user: "expense_app_runtime",
          password: runtimePassword,
          database: databaseName,
        }),
      }),
    });
  });

  afterAll(async () => {
    await database?.destroy();
    await migratorDatabase?.destroy();
    if (postgresContainerId) adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
  });

  it("keeps historical rows null and enforces tax amount bounds", async () => {
    const db = migratorDatabase!;
    const historical = await sql<{ tax_amount: string | null }>`
      SELECT tax_amount FROM app.expenses WHERE id = ${HISTORICAL_EXPENSE_ID}
    `.execute(db);
    expect(historical.rows[0]?.tax_amount).toBeNull();

    for (const [suffix, taxAmount] of [["null", null], ["zero", "0.00"], ["positive", "1.23"]] as const) {
      await expect(sql`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, merchant, amount, tax_amount, currency, incurred_on)
        VALUES
          (${randomUUID()}, ${TENANT_ID}, ${USER_ID}, ${PROFILE_ID}, ${suffix}, 10.00, ${taxAmount}, 'USD', '2026-01-02')
      `.execute(db)).resolves.toBeDefined();
    }

    for (const taxAmount of ["-0.01", "10.01"]) {
      await expect(sql`
        INSERT INTO app.expenses
          (id, tenant_id, created_by_user_id, personal_profile_id, merchant, amount, tax_amount, currency, incurred_on)
        VALUES
          (${randomUUID()}, ${TENANT_ID}, ${USER_ID}, ${PROFILE_ID}, 'Rejected', 10.00, ${taxAmount}, 'USD', '2026-01-02')
      `.execute(db)).rejects.toThrow(/expenses_tax_amount/);
    }
  });

  it("maps null and exact stored decimal strings", async () => {
    await sql`
      INSERT INTO app.expenses
        (id, tenant_id, created_by_user_id, personal_profile_id, merchant, amount, tax_amount, currency, incurred_on)
      VALUES
        (${STORED_EXPENSE_ID}, ${TENANT_ID}, ${USER_ID}, ${PROFILE_ID}, 'Stored', 10.00, 1.23, 'USD', '2026-01-03')
    `.execute(migratorDatabase!);
    const domain = createExpenseDomain(database!);

    await expect(domain.getPersonal({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      profileId: PROFILE_ID,
      expenseId: HISTORICAL_EXPENSE_ID,
    })).resolves.toMatchObject({ taxAmount: null });
    await expect(domain.getPersonal({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      profileId: PROFILE_ID,
      expenseId: STORED_EXPENSE_ID,
    })).resolves.toMatchObject({ taxAmount: "1.23" });
  });

  it("persists exact create and update tax amount strings", async () => {
    const domain = createExpenseDomain(database!);
    const created = await domain.createPersonal({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      profileId: PROFILE_ID,
      request: {
        personalProfileId: PROFILE_ID,
        merchant: "Created",
        amount: "20.00",
        taxAmount: "2.40",
        currency: "USD",
        incurredOn: "2026-01-04",
      },
      requestId: `tax-create-${runKey}`,
    });
    expect(created.taxAmount).toBe("2.40");

    const updated = await domain.updatePersonal({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      profileId: PROFILE_ID,
      expenseId: created.id,
      request: { expectedVersion: created.version, taxAmount: "3.50" },
      requestId: `tax-update-${runKey}`,
    });
    expect(updated.taxAmount).toBe("3.50");
    const stored = await sql<{ tax_amount: string | null }>`
      SELECT tax_amount FROM app.expenses WHERE id = ${created.id}
    `.execute(database!);
    expect(stored.rows[0]?.tax_amount).toBe("3.50");
  });
});
