import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFoundryDatabase } from "../../services/foundry-service/src/database/client.js";
import type { FoundryDatabase } from "../../services/foundry-service/src/database/types.js";
import { createCatalogDomain } from "../../services/foundry-service/src/domain/catalog.js";
import { createPostgresSecretStore } from "../../services/foundry-service/src/domain/secrets.js";
import { DomainError } from "../../services/foundry-service/src/errors.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0K_WAVE_A_INTEGRATION === "1";
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

function expectConstraint(sql: string, constraintName: string): void {
  const result = runSql(sql);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(constraintName);
}

describe.skipIf(!integrationEnabled)("Phase 0K Wave A provider/model catalog", () => {
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
      throw new Error("Phase 0K Wave A PostgreSQL prerequisites are missing");
    }
    database = createFoundryDatabase(
      `postgresql://expense_foundry_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5432/expense_tax_db`,
    );
  });

  afterAll(async () => {
    if (!postgresContainerId || !runtimePassword) return;
    runSql(`DELETE FROM foundry.ai_modes WHERE key LIKE 'cat-${runKey}-%';`);
    runSql(
      `DELETE FROM foundry.provider_connections WHERE key LIKE 'cat-${runKey}-%';`,
    );
    await database.destroy();
  });

  it("creates provider/model catalog tables", () => {
    expect(
      executeSql(`
        SELECT string_agg(name, ',' ORDER BY name)
        FROM unnest(ARRAY[
          'foundry.provider_secrets',
          'foundry.provider_connections',
          'foundry.ai_models',
          'foundry.ai_modes',
          'foundry.ai_mode_route_versions',
          'foundry.foundry_audit_events'
        ]) AS name
        WHERE to_regclass(name) IS NOT NULL;
      `),
    ).toBe(
      "foundry.ai_models,foundry.ai_mode_route_versions,foundry.ai_modes,foundry.foundry_audit_events,foundry.provider_connections,foundry.provider_secrets",
    );
  });

  it("enforces one current route version per mode and catalog key format", () => {
    const modeId = randomUUID();
    const modelAId = randomUUID();
    const modelBId = randomUUID();
    const connectionId = randomUUID();
    const secretId = randomUUID();
    executeSql(`
      INSERT INTO foundry.provider_secrets (id, value) VALUES ('${secretId}', 'sk-test');
      INSERT INTO foundry.provider_connections (id, key, provider_kind, display_name, secret_reference)
      VALUES ('${connectionId}', 'cat-${runKey}-conn', 'openai', 'Test Connection', '${secretId}');
      INSERT INTO foundry.ai_models (id, provider_connection_id, provider_model_id, metered_model_key)
      VALUES ('${modelAId}', '${connectionId}', 'gpt-a', 'metered-a');
      INSERT INTO foundry.ai_models (id, provider_connection_id, provider_model_id, metered_model_key)
      VALUES ('${modelBId}', '${connectionId}', 'gpt-b', 'metered-b');
      INSERT INTO foundry.ai_modes (id, key, display_name, operation)
      VALUES ('${modeId}', 'cat-${runKey}-fast', 'Fast', 'RECEIPT_OCR');
      INSERT INTO foundry.ai_mode_route_versions (id, ai_mode_id, version_number, ai_model_id, is_current)
      VALUES ('${randomUUID()}', '${modeId}', 1, '${modelAId}', true);
    `);
    expectConstraint(
      `INSERT INTO foundry.ai_mode_route_versions (id, ai_mode_id, version_number, ai_model_id, is_current)
       VALUES ('${randomUUID()}', '${modeId}', 2, '${modelBId}', true);`,
      "ai_mode_route_versions_one_current_per_mode",
    );
    expectConstraint(
      `INSERT INTO foundry.provider_connections (id, key, provider_kind, display_name, secret_reference)
       VALUES ('${randomUUID()}', 'Not-Lowercase', 'openai', 'x', '${secretId}');`,
      "provider_connections_key_check",
    );
  });

  it("runs the full catalog lifecycle via the domain layer, never exposing the raw secret", async () => {
    const secretStore = createPostgresSecretStore(database);
    const domain = createCatalogDomain(database, secretStore);
    const actor = { actorPlatformSubject: "operator-1", requestId: `cat-${runKey}-lifecycle` };

    const connection = await domain.createProviderConnection({
      ...actor,
      request: {
        key: `cat-${runKey}-openai`,
        providerKind: "openai",
        displayName: "OpenAI",
        secretValue: "sk-do-not-leak",
      },
    });
    expect(connection).not.toHaveProperty("secretValue");
    expect(JSON.stringify(connection)).not.toContain("sk-do-not-leak");
    expect(await secretStore.exists(connection.secretReference)).toBe(true);
    expect(
      executeSql(
        `SELECT value FROM foundry.provider_secrets WHERE id = '${connection.secretReference}';`,
      ),
    ).toBe("sk-do-not-leak");

    const model = await domain.createAiModel({
      ...actor,
      request: {
        providerConnectionId: connection.id,
        providerModelId: "gpt-4o-mini",
        meteredModelKey: "gpt-4o-mini-ocr",
      },
    });
    expect(model.providerConnectionId).toBe(connection.id);

    const mode = await domain.createAiMode({
      ...actor,
      request: {
        key: `cat-${runKey}-lifecycle-fast`,
        displayName: "Fast",
        operation: "RECEIPT_OCR",
      },
    });
    expect(mode.operation).toBe("RECEIPT_OCR");

    const routeV1 = await domain.createRouteVersion({
      ...actor,
      aiModeId: mode.id,
      request: { aiModelId: model.id },
    });
    expect(routeV1).toMatchObject({ versionNumber: 1, isCurrent: true, aiModelId: model.id });

    const secondModel = await domain.createAiModel({
      ...actor,
      request: {
        providerConnectionId: connection.id,
        providerModelId: "gpt-4o",
        meteredModelKey: "gpt-4o-ocr",
      },
    });
    const routeV2 = await domain.createRouteVersion({
      ...actor,
      aiModeId: mode.id,
      request: { aiModelId: secondModel.id },
    });
    expect(routeV2).toMatchObject({ versionNumber: 2, isCurrent: true, aiModelId: secondModel.id });
    expect(
      executeSql(
        `SELECT is_current FROM foundry.ai_mode_route_versions WHERE id = '${routeV1.id}';`,
      ),
    ).toBe("f");

    const rotated = await domain.updateProviderConnection({
      ...actor,
      id: connection.id,
      request: { secretValue: "sk-rotated" },
    });
    expect(rotated.secretReference).not.toBe(connection.secretReference);
    expect(await secretStore.exists(connection.secretReference)).toBe(true);
    expect(await secretStore.exists(rotated.secretReference)).toBe(true);
    expect(
      executeSql(
        `SELECT value FROM foundry.provider_secrets WHERE id = '${rotated.secretReference}';`,
      ),
    ).toBe("sk-rotated");

    await expect(
      domain.updateProviderConnection({
        ...actor,
        id: randomUUID(),
        request: { status: "disabled" },
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "NOT_FOUND" });

    const auditCount = executeSql(`
      SELECT count(*) FROM foundry.foundry_audit_events
      WHERE resource_type IN ('provider_connection', 'ai_model', 'ai_mode', 'ai_mode_route_version')
        AND request_id LIKE 'cat-${runKey}-%';
    `);
    expect(Number(auditCount)).toBeGreaterThanOrEqual(6);
  });
});
