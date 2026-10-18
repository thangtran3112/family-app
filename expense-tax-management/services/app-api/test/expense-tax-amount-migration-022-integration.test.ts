import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertLocalDockerEndpoint } from "../../../scripts/local-worker-smoke.mjs";

const requested = process.env.EXPENSE_TAX_AMOUNT_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/database/migrations",
);
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_amount_${runKey}`;

describe("expense tax amount integration transport", () => {
  it("refuses Docker overrides and non-unix context endpoints", () => {
    expect(() =>
      assertLocalDockerEndpoint(
        { DOCKER_HOST: "unix:///tmp/docker-proxy.sock" },
        () => "unix:///var/run/docker.sock",
      ),
    ).toThrow(/DOCKER_HOST is set/);
    expect(() =>
      assertLocalDockerEndpoint({}, () => "tcp://remote.invalid:2375"),
    ).toThrow(/not a local unix socket/);
  });

  it("contains no host PostgreSQL connection path", async () => {
    const source = await fs.readFile(fileURLToPath(import.meta.url), "utf8");
    const forbidden = [
      ["EXPENSE", "TAX", "POSTGRES", "PORT"].join("_"),
      ["new", "Pool("].join(" "),
      ["host:", '"local' + 'host"'].join(" "),
      ["127", "0", "0", "1"].join("."),
      ["54", "33"].join(""),
    ];

    for (const value of forbidden) expect(source).not.toContain(value);
    const guardIndex = source.indexOf("\n    assertLocalDockerEndpoint();");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(source.indexOf("\n    const postgresContainerId ="));
  });
});

function dockerPsql(containerId: string, dbName: string, sqlText: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      containerId,
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
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

async function migrationSql(): Promise<string> {
  const source = await fs.readFile(path.join(migrationsFolder, "022_expense_tax_amount.ts"), "utf8");
  const match = source.match(/await sql`([\s\S]*?)`\.execute\(database\);/);
  if (!match?.[1] || match[1].includes("${")) {
    throw new Error("Migration 022 must contain one static SQL statement");
  }
  return match[1];
}

describe.skipIf(!requested)("migration 022 expense tax amount", () => {
  it("applies and proves nullable exact values and bounds inside a rolled-back transaction", async () => {
    assertLocalDockerEndpoint();
    const postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!postgresContainerId) {
      throw new Error("Expense tax amount PostgreSQL prerequisites unavailable");
    }

    dockerPsql(postgresContainerId, "postgres", `CREATE DATABASE ${databaseName};`);
    try {
      dockerPsql(postgresContainerId, databaseName, `
        BEGIN;
        CREATE SCHEMA app;
        CREATE TABLE app.expenses (
          id uuid PRIMARY KEY,
          amount numeric(14, 2) NOT NULL
        );
        INSERT INTO app.expenses (id, amount)
        VALUES ('22000000-0000-4000-8000-000000000001', 10.00);

        ${await migrationSql()};

        DO $assertions$
        DECLARE
          actual text;
          failed_constraint text;
        BEGIN
          SELECT tax_amount::text INTO actual
          FROM app.expenses WHERE id = '22000000-0000-4000-8000-000000000001';
          IF actual IS NOT NULL THEN
            RAISE EXCEPTION 'historical tax amount must remain null';
          END IF;

          INSERT INTO app.expenses (id, amount, tax_amount) VALUES
            ('22000000-0000-4000-8000-000000000002', 10.00, NULL),
            ('22000000-0000-4000-8000-000000000003', 10.00, 0.00),
            ('22000000-0000-4000-8000-000000000004', 10.00, 1.23),
            ('22000000-0000-4000-8000-000000000005', 20.00, 2.40);

          SELECT tax_amount::text INTO actual
          FROM app.expenses WHERE id = '22000000-0000-4000-8000-000000000005';
          IF actual <> '2.40' THEN
            RAISE EXCEPTION 'expected exact stored tax amount 2.40, got %', actual;
          END IF;
          UPDATE app.expenses SET tax_amount = 3.50
          WHERE id = '22000000-0000-4000-8000-000000000005';
          SELECT tax_amount::text INTO actual
          FROM app.expenses WHERE id = '22000000-0000-4000-8000-000000000005';
          IF actual <> '3.50' THEN
            RAISE EXCEPTION 'expected exact updated tax amount 3.50, got %', actual;
          END IF;

          BEGIN
            INSERT INTO app.expenses (id, amount, tax_amount)
            VALUES ('22000000-0000-4000-8000-000000000006', 10.00, -0.01);
            RAISE EXCEPTION 'negative tax amount was accepted';
          EXCEPTION WHEN check_violation THEN
            GET STACKED DIAGNOSTICS failed_constraint = CONSTRAINT_NAME;
            IF failed_constraint <> 'expenses_tax_amount_nonnegative_check' THEN
              RAISE EXCEPTION 'unexpected constraint: %', failed_constraint;
            END IF;
          END;

          BEGIN
            INSERT INTO app.expenses (id, amount, tax_amount)
            VALUES ('22000000-0000-4000-8000-000000000007', 10.00, 10.01);
            RAISE EXCEPTION 'tax amount above total was accepted';
          EXCEPTION WHEN check_violation THEN
            GET STACKED DIAGNOSTICS failed_constraint = CONSTRAINT_NAME;
            IF failed_constraint <> 'expenses_tax_amount_not_greater_than_amount_check' THEN
              RAISE EXCEPTION 'unexpected constraint: %', failed_constraint;
            END IF;
          END;
        END
        $assertions$;
        ROLLBACK;
      `);
    } finally {
      dockerPsql(postgresContainerId, "postgres", `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
    }
  }, 30_000);
});
