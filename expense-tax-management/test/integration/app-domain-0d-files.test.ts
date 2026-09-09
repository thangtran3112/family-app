import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import { buildApp } from "../../services/app-api/src/app.js";
import { createAppConfig } from "../../services/app-api/src/config.js";
import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createFilesDomain } from "../../services/app-api/src/domain/files.js";
import { DomainError } from "../../services/app-api/src/errors.js";
import { createLocalStorageAdapter } from "../../services/app-api/src/storage/local.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0D_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().slice(0, 8);
const SIGNING_KEY = `0d-test-signing-key-${runKey}`;

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

async function tinyJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer();
}

const TINY_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF",
  "utf8",
);

describe.skipIf(!integrationEnabled)("Phase 0D expense files", () => {
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
      throw new Error("Phase 0D PostgreSQL prerequisites are missing");
    }
    database = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
    storageRoot = await mkdtemp(path.join(tmpdir(), `expense-tax-0d-${runKey}-`));
  });

  afterAll(async () => {
    if (postgresContainerId && runtimePassword) {
      // Audit rows reference users with ON DELETE SET NULL, but the audit
      // CHECK requires an actor -- so remove our audit rows first, before
      // deleting tenants/users (all our requestIds carry the runKey).
      executeSql(`DELETE FROM app.app_audit_events WHERE request_id LIKE '0d-${runKey}-%';`);
      executeSql(`DELETE FROM app.tenants WHERE slug LIKE '0d-${runKey}-%';`);
      executeSql(`DELETE FROM app.users WHERE primary_email LIKE '0d-${runKey}-%';`);
    }
    await database?.destroy();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it("creates the file and upload-session tables", () => {
    expect(
      executeSql(`
        SELECT string_agg(name, ',' ORDER BY name)
        FROM unnest(ARRAY['app.expense_files', 'app.upload_sessions']) AS name
        WHERE to_regclass(name) IS NOT NULL;
      `),
    ).toBe("app.expense_files,app.upload_sessions");
  });

  it("enforces exactly-one-scope and the content-type allowlist at the database level", () => {
    const { tenantId, profileId } = seedTenantWithProfile();
    const fileId = randomUUID();
    const badScope = runSql(`
      INSERT INTO app.expense_files (id, tenant_id, original_filename, content_type, storage_key)
      VALUES ('${fileId}', '${tenantId}', 'x.jpg', 'image/jpeg', '0d-${runKey}/neither');
    `);
    expect(badScope.status).not.toBe(0);
    expect(badScope.stderr).toContain("expense_files_scope_check");

    const badType = runSql(`
      INSERT INTO app.expense_files (id, tenant_id, personal_profile_id, original_filename, content_type, storage_key)
      VALUES ('${randomUUID()}', '${tenantId}', '${profileId}', 'x.exe', 'application/x-msdownload', '0d-${runKey}/badtype');
    `);
    expect(badType.status).not.toBe(0);
    expect(badType.stderr).toContain("expense_files_content_type_check");
  });

  it("runs create -> PUT bytes over real HTTP -> confirm -> READY with a real thumbnail on disk", async () => {
    const { userId, tenantId, profileId } = seedTenantWithProfile();
    const adapter = createLocalStorageAdapter({
      rootDir: storageRoot,
      baseUrl: "http://127.0.0.1:8100",
      signingKey: SIGNING_KEY,
    });
    const domain = createFilesDomain(database, adapter);

    const created = await domain.createUploadSession({
      actorUserId: userId,
      tenantId,
      scope: { kind: "personal", profileId },
      request: { originalFilename: "receipt.jpg", contentType: "image/jpeg" },
      idempotencyKey: `0d-${runKey}-create-1`,
      requestId: `0d-${runKey}-create-1`,
    });
    expect(created.body.file.status).toBe("PENDING");
    expect(created.body.uploadTarget.method).toBe("PUT");

    // PUT the bytes through a real listening Fastify instance so the
    // bearer-free signature check, content-type parser, and size cap run
    // for real -- no auth fakery needed, the signature IS the auth.
    const app = buildApp({
      config: createAppConfig({
        env: {
          APP_TENANT_TOKEN_ISSUER: "https://identity.test",
          APP_TENANT_TOKEN_AUDIENCE: "expense-app",
          APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
          APP_SERVICE_TOKEN_ISSUER: "https://services.test",
          APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
          APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
          APP_DATABASE_URL: "postgresql://unused.test/app",
          TEMPORAL_HOST: "127.0.0.1:7233",
          TEMPORAL_NAMESPACE: "default",
          STORAGE_BACKEND: "local",
          LOCAL_STORAGE_DIR: storageRoot,
          STORAGE_LOCAL_BASE_URL: "placeholder-will-rewrite",
          STORAGE_URL_SIGNING_KEY: SIGNING_KEY,
        },
        version: "test",
      }),
      logger: false,
      database,
      authVerifiers: {
        tenant: { verify: async () => { throw new Error("unused"); } },
        service: { verify: async () => { throw new Error("unused"); } },
      },
      filesDomain: domain,
    });
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      // Rewrite the signed URL's origin to the ephemeral listen port: the
      // path+query (fileId, expires, signature) stay byte-identical, and
      // the signature only covers method/fileId/expires -- never the host.
      const target = new URL(created.body.uploadTarget.url);
      target.host = `127.0.0.1:${address.port}`;
      target.protocol = "http:";
      const bytes = await tinyJpeg();
      const putResponse = await fetch(target, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: new Uint8Array(bytes),
      });
      expect(putResponse.status).toBe(204);

      const confirmed = await domain.confirmUploadSession({
        actorUserId: userId,
        tenantId,
        scope: { kind: "personal", profileId },
        sessionId: created.body.uploadSession.id,
        requestId: `0d-${runKey}-confirm-1`,
      });
      expect(confirmed.status).toBe("READY");
      expect(confirmed.sizeBytes).toBe(bytes.byteLength);
      expect(confirmed.sha256Hex).toMatch(/^[a-f0-9]{64}$/);
      expect(confirmed.thumbnailStatus).toBe("ready");
      expect(confirmed.thumbnailStorageKey).not.toBeNull();

      const thumbnailPath = path.join(storageRoot, confirmed.thumbnailStorageKey as string);
      const thumbnailStat = await stat(thumbnailPath);
      expect(thumbnailStat.size).toBeGreaterThan(0);
      const metadata = await sharp(thumbnailPath).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.width ?? 999).toBeLessThanOrEqual(300);

      // Confirm-twice is an idempotent replay, not an error.
      const reconfirmed = await domain.confirmUploadSession({
        actorUserId: userId,
        tenantId,
        scope: { kind: "personal", profileId },
        sessionId: created.body.uploadSession.id,
        requestId: `0d-${runKey}-confirm-2`,
      });
      expect(reconfirmed.version).toBe(confirmed.version);

      // Worker read-url issuance + real GET round-trip over HTTP.
      const workerUrl = await domain.issueWorkerReadUrl({
        fileId: confirmed.id,
        actorServicePrincipal: "ai-worker",
        requestId: `0d-${runKey}-worker-url`,
      });
      const workerTarget = new URL(workerUrl.url);
      workerTarget.host = `127.0.0.1:${address.port}`;
      workerTarget.protocol = "http:";
      const getResponse = await fetch(workerTarget);
      expect(getResponse.status).toBe(200);
      expect(getResponse.headers.get("content-type")).toContain("image/jpeg");

      // Delete removes objects from disk and tombstones the row.
      await domain.deleteFile({
        actorUserId: userId,
        tenantId,
        scope: { kind: "personal", profileId },
        fileId: confirmed.id,
        requestId: `0d-${runKey}-delete`,
      });
      await expect(stat(thumbnailPath)).rejects.toThrow();
      await expect(
        domain.getFile({
          actorUserId: userId,
          tenantId,
          scope: { kind: "personal", profileId },
          fileId: confirmed.id,
        }),
      ).rejects.toMatchObject<Partial<DomainError>>({ code: "NOT_FOUND" });
    } finally {
      await app.close();
    }
  });

  it("stores PDFs original-only and rejects non-PDF bytes declared as PDF", async () => {
    const { userId, tenantId, profileId } = seedTenantWithProfile();
    const adapter = createLocalStorageAdapter({
      rootDir: storageRoot,
      baseUrl: "http://127.0.0.1:8100",
      signingKey: SIGNING_KEY,
    });
    const domain = createFilesDomain(database, adapter);

    const pdf = await domain.createUploadSession({
      actorUserId: userId,
      tenantId,
      scope: { kind: "personal", profileId },
      request: { originalFilename: "receipt.pdf", contentType: "application/pdf" },
      idempotencyKey: `0d-${runKey}-pdf-1`,
      requestId: `0d-${runKey}-pdf-1`,
    });
    const pdfFile = await database
      .selectFrom("app.expense_files")
      .selectAll()
      .where("id", "=", pdf.body.file.id)
      .executeTakeFirstOrThrow();
    await adapter.writeObject({
      storageKey: pdfFile.storage_key,
      data: TINY_PDF,
      contentType: "application/pdf",
    });
    const confirmedPdf = await domain.confirmUploadSession({
      actorUserId: userId,
      tenantId,
      scope: { kind: "personal", profileId },
      sessionId: pdf.body.uploadSession.id,
      requestId: `0d-${runKey}-pdf-confirm`,
    });
    expect(confirmedPdf.status).toBe("READY");
    expect(confirmedPdf.thumbnailStatus).toBe("skipped");
    expect(confirmedPdf.thumbnailStorageKey).toBeNull();

    const fake = await domain.createUploadSession({
      actorUserId: userId,
      tenantId,
      scope: { kind: "personal", profileId },
      request: { originalFilename: "fake.pdf", contentType: "application/pdf" },
      idempotencyKey: `0d-${runKey}-fakepdf-1`,
      requestId: `0d-${runKey}-fakepdf-1`,
    });
    const fakeFile = await database
      .selectFrom("app.expense_files")
      .selectAll()
      .where("id", "=", fake.body.file.id)
      .executeTakeFirstOrThrow();
    await adapter.writeObject({
      storageKey: fakeFile.storage_key,
      data: Buffer.from("this is not a pdf", "utf8"),
      contentType: "application/pdf",
    });
    await expect(
      domain.confirmUploadSession({
        actorUserId: userId,
        tenantId,
        scope: { kind: "personal", profileId },
        sessionId: fake.body.uploadSession.id,
        requestId: `0d-${runKey}-fakepdf-confirm`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "VALIDATION_ERROR" });
  });

  it("expires stale sessions lazily and isolates tenants", async () => {
    const first = seedTenantWithProfile();
    const second = seedTenantWithProfile();
    const adapter = createLocalStorageAdapter({
      rootDir: storageRoot,
      baseUrl: "http://127.0.0.1:8100",
      signingKey: SIGNING_KEY,
    });
    const domain = createFilesDomain(database, adapter);

    const created = await domain.createUploadSession({
      actorUserId: first.userId,
      tenantId: first.tenantId,
      scope: { kind: "personal", profileId: first.profileId },
      request: { originalFilename: "late.jpg", contentType: "image/jpeg" },
      idempotencyKey: `0d-${runKey}-expiry-1`,
      requestId: `0d-${runKey}-expiry-1`,
    });
    executeSql(`
      UPDATE app.upload_sessions SET expires_at = now() - interval '1 minute'
      WHERE id = '${created.body.uploadSession.id}';
    `);
    await expect(
      domain.confirmUploadSession({
        actorUserId: first.userId,
        tenantId: first.tenantId,
        scope: { kind: "personal", profileId: first.profileId },
        sessionId: created.body.uploadSession.id,
        requestId: `0d-${runKey}-expiry-confirm`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
    expect(
      executeSql(
        `SELECT status FROM app.upload_sessions WHERE id = '${created.body.uploadSession.id}';`,
      ),
    ).toBe("EXPIRED");

    // Cross-tenant reads see nothing (tenant isolation, not a 403 leak).
    await expect(
      domain.getFile({
        actorUserId: second.userId,
        tenantId: second.tenantId,
        scope: { kind: "personal", profileId: second.profileId },
        fileId: created.body.file.id,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "NOT_FOUND" });
  });

  it("paginates the file list newest-first", async () => {
    const { userId, tenantId, profileId } = seedTenantWithProfile();
    const adapter = createLocalStorageAdapter({
      rootDir: storageRoot,
      baseUrl: "http://127.0.0.1:8100",
      signingKey: SIGNING_KEY,
    });
    const domain = createFilesDomain(database, adapter);
    for (let index = 0; index < 3; index += 1) {
      const created = await domain.createUploadSession({
        actorUserId: userId,
        tenantId,
        scope: { kind: "personal", profileId },
        request: { originalFilename: `r${index}.jpg`, contentType: "image/jpeg" },
        idempotencyKey: `0d-${runKey}-page-${index}`,
        requestId: `0d-${runKey}-page-${index}`,
      });
      const row = await database
        .selectFrom("app.expense_files")
        .selectAll()
        .where("id", "=", created.body.file.id)
        .executeTakeFirstOrThrow();
      await adapter.writeObject({
        storageKey: row.storage_key,
        data: await tinyJpeg(),
        contentType: "image/jpeg",
      });
      await domain.confirmUploadSession({
        actorUserId: userId,
        tenantId,
        scope: { kind: "personal", profileId },
        sessionId: created.body.uploadSession.id,
        requestId: `0d-${runKey}-page-confirm-${index}`,
      });
    }
    const firstPage = await domain.listFiles({
      actorUserId: userId,
      tenantId,
      scope: { kind: "personal", profileId },
      limit: 2,
    });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await domain.listFiles({
      actorUserId: userId,
      tenantId,
      scope: { kind: "personal", profileId },
      limit: 2,
      cursor: firstPage.nextCursor as string,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
  });
});

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
    VALUES ('${userId}', '0d-${runKey}-${userId.slice(0, 6)}@example.test', '0D User');
    INSERT INTO app.tenants (id, name, slug)
    VALUES ('${tenantId}', '0D Tenant', '0d-${runKey}-${tenantId.slice(0, 6)}');
    INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
    VALUES ('${tenantId}', '${userId}', 'owner');
    INSERT INTO app.personal_profiles (id, tenant_id, name)
    VALUES ('${profileId}', '${tenantId}', 'Personal');
    INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role)
    VALUES ('${profileId}', '${tenantId}', '${userId}', 'owner');
  `);
  return { userId, tenantId, profileId };
}
