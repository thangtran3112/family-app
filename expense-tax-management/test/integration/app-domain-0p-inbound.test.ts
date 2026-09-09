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
import { createInboundEmailDomain } from "../../services/app-api/src/domain/inbound-email.js";
import { createOcrJobsDomain } from "../../services/app-api/src/domain/ocr.js";
import { createPlansDomain } from "../../services/app-api/src/domain/plans.js";
import { createProcessingJobsDomain } from "../../services/app-api/src/domain/processing-jobs.js";
import { PatternMalwareScanner } from "../../services/app-api/src/inbound/security.js";
import { createLocalStorageAdapter } from "../../services/app-api/src/storage/local.js";
import type { VerificationNotifier } from "../../services/app-api/src/inbound/notifier.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0P_INTEGRATION === "1";
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
      "exec", "-e", `PGPASSWORD=${runtimePassword}`, postgresContainerId,
      "psql", "-X", "-v", "ON_ERROR_STOP=1", "--host", "127.0.0.1",
      "--username", "expense_app_runtime", "--dbname", "expense_tax_db",
      "--tuples-only", "--no-align", "--pset", "footer=off", "--command", sql,
    ],
    { encoding: "utf8" },
  );
}

function executeSql(sql: string): string {
  const result = runSql(sql);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function seedTenant(): { userId: string; tenantId: string; profileId: string } {
  const userId = randomUUID();
  const tenantId = randomUUID();
  const profileId = randomUUID();
  executeSql(`
    INSERT INTO app.users (id, primary_email, display_name)
    VALUES ('${userId}', '0p-${runKey}-${userId.slice(0, 6)}@example.test', '0P Owner');
    INSERT INTO app.tenants (id, name, slug)
    VALUES ('${tenantId}', '0P Tenant', '0p-${runKey}-${tenantId.slice(0, 6)}');
    INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
    VALUES ('${tenantId}', '${userId}', 'owner');
    INSERT INTO app.personal_profiles (id, tenant_id, name)
    VALUES ('${profileId}', '${tenantId}', 'Personal');
    INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role)
    VALUES ('${profileId}', '${tenantId}', '${userId}', 'owner');
  `);
  return { userId, tenantId, profileId };
}

function pdf(text = "receipt"): Buffer {
  return Buffer.from(`%PDF-1.4\n${text}\n%%EOF`, "utf8");
}

describe.skipIf(!integrationEnabled)("Phase 0P forwarded receipt intake", () => {
  beforeAll(async () => {
    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as { services: Record<string, { environment?: Record<string, string | null> }> };
    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    }).trim();
    runtimePassword = config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    if (!postgresContainerId || !runtimePassword) throw new Error("0P prerequisites missing");
    database = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
    storageRoot = await mkdtemp(path.join(tmpdir(), `expense-tax-0p-${runKey}-`));
  });

  afterAll(async () => {
    if (postgresContainerId && runtimePassword) {
      const tenants = executeSql(
        `SELECT id FROM app.tenants WHERE slug LIKE '0p-${runKey}-%';`,
      ).split("\n").filter(Boolean);
      for (const tenant of tenants) {
        executeSql(`DELETE FROM app.app_audit_events WHERE tenant_id = '${tenant}';`);
      }
      executeSql(`DELETE FROM app.idempotency_records WHERE actor_key IN (SELECT 'user:' || id::text FROM app.users WHERE primary_email LIKE '0p-${runKey}-%');`);
      executeSql(`DELETE FROM app.tenants WHERE slug LIKE '0p-${runKey}-%';`);
      executeSql(`DELETE FROM app.users WHERE primary_email LIKE '0p-${runKey}-%';`);
      executeSql(`DELETE FROM app.inbound_emails WHERE tenant_id IS NULL AND provider_message_id LIKE '0p-${runKey}-%';`);
    }
    await database?.destroy();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  function harness() {
    let challenge = "";
    const notifier: VerificationNotifier = {
      async send(input) {
        challenge = input.token;
      },
    };
    const storage = createLocalStorageAdapter({
      rootDir: storageRoot,
      baseUrl: "http://127.0.0.1:8100",
      signingKey: `0p-storage-${runKey}`,
    });
    const filesDomain = createFilesDomain(database, storage);
    const plansDomain = createPlansDomain(database);
    const ocrJobsDomain = createOcrJobsDomain(database, { plansDomain, filesDomain });
    const inbound = createInboundEmailDomain(database, {
      filesDomain,
      ocrJobsDomain,
      plansDomain,
      notifier,
      malwareScanner: PatternMalwareScanner,
      config: {
        baseAddress: "receipts@inbound.test",
        routingTokenSecret: `0p-routing-${runKey}`,
      },
    });
    return { inbound, getChallenge: () => challenge };
  }

  async function verifiedSetup() {
    const tenant = seedTenant();
    const h = harness();
    const scope = { kind: "personal" as const, profileId: tenant.profileId };
    const sender = await h.inbound.createSender({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope,
      email: "Owner@Example.test",
      requestId: `0p-${runKey}-sender`,
    });
    expect(sender.status).toBe("pending");
    expect(h.getChallenge().length).toBeGreaterThanOrEqual(32);
    await expect(
      h.inbound.verifySender({
        actorUserId: tenant.userId,
        tenantId: tenant.tenantId,
        scope,
        senderId: sender.id,
        verificationToken: "wrong-token-that-is-long-enough-000000",
        requestId: `0p-${runKey}-wrong-token`,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const verified = await h.inbound.verifySender({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope,
      senderId: sender.id,
      verificationToken: h.getChallenge(),
      requestId: `0p-${runKey}-verify`,
    });
    expect(verified.status).toBe("verified");
    const token = await h.inbound.rotateRoutingToken({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope,
      requestId: `0p-${runKey}-route`,
    });
    expect(token.routingAddress).toMatch(/^receipts\+[a-f0-9]{32}@inbound\.test$/);
    expect((await h.inbound.getRoutingToken({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope,
    })).routingAddress).toBe(token.routingAddress);
    return { ...tenant, ...h, scope, sender, token };
  }

  function payload(input: {
    messageId: string;
    recipient: string;
    sender?: string;
    bytes?: Buffer;
    authPass?: boolean;
    subject?: string;
  }) {
    return {
      providerMessageId: input.messageId,
      recipientAddress: input.recipient,
      senderEmail: input.sender ?? "owner@example.test",
      subject: input.subject ?? "Receipt",
      htmlBody: "<script>evil()</script><b>Safe body</b>",
      receivedAt: "2026-09-09T00:00:00.000Z",
      auth: input.authPass === false
        ? { spf: "fail" as const, dkim: "fail" as const, dmarc: "fail" as const, arc: "none" as const }
        : { spf: "pass" as const, dkim: "pass" as const, dmarc: "pass" as const, arc: "none" as const },
      attachments: [
        {
          filename: "receipt.pdf",
          contentType: "application/pdf" as const,
          dataBase64: (input.bytes ?? pdf()).toString("base64"),
        },
      ],
    };
  }

  it("verifies a sender, rotates an opaque route, and accepts trusted mail into 0D/0C", async () => {
    const s = await verifiedSetup();
    const accepted = await s.inbound.handleWebhook(
      payload({
        messageId: `0p-${runKey}-accepted`,
        recipient: s.token.routingAddress,
        subject: "<script>x()</script><b>Receipt</b>",
      }),
    );
    expect(accepted.inboundEmail.status).toBe("ACCEPTED");
    expect(accepted.inboundEmail.subject).toBe("Receipt");
    expect(accepted.createdFileIds).toHaveLength(1);
    expect(accepted.createdJobIds).toHaveLength(1);
    expect(
      executeSql(`SELECT status FROM app.expense_files WHERE id = '${accepted.createdFileIds[0]}';`),
    ).toBe("READY");
    expect(
      executeSql(`SELECT workflow_type FROM app.processing_jobs WHERE id = '${accepted.createdJobIds[0]}';`),
    ).toBe("ForwardedReceiptWorkflow");

    // Applying the standard OCR result preserves forwarded provenance on
    // the expense (not generic `ocr`).
    const jobId = accepted.createdJobIds[0] as string;
    executeSql(`
      UPDATE app.processing_jobs
      SET status = 'DISPATCHED', run_id = 'forwarded-test', dispatched_at = now(), version = 2
      WHERE id = '${jobId}';
    `);
    const jobs = createProcessingJobsDomain(database, {
      start: async () => ({ runId: "unused" }),
      close: async () => undefined,
    });
    const applied = await jobs.submitResult({
      jobId,
      request: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: `${jobId}:forwarded:result`,
        expectedJobVersion: 2,
        resultSchemaVersion: "ocr-extraction-v1",
        result: {
          schemaVersion: 1,
          merchant: "Forwarded Merchant",
          amount: "9.99",
          currency: "USD",
          incurredOn: "2026-09-09",
          confidence: 1,
        },
      },
      actorServicePrincipal: "ai-worker",
      requestId: `0p-${runKey}-forwarded-result`,
    });
    expect(
      executeSql(`SELECT source FROM app.expenses WHERE id = '${applied.body.targetAggregateId}';`),
    ).toBe("forwarded_email");

    // Same provider ID + same content is idempotent (no duplicate file/job).
    const replay = await s.inbound.handleWebhook(
      payload({ messageId: `0p-${runKey}-accepted`, recipient: s.token.routingAddress }),
    );
    expect(replay.createdFileIds).toHaveLength(0);
    expect(replay.createdJobIds).toHaveLength(0);

    // Same content under a new provider ID is quarantined pre-OCR.
    const duplicate = await s.inbound.handleWebhook(
      payload({ messageId: `0p-${runKey}-duplicate`, recipient: s.token.routingAddress }),
    );
    expect(duplicate.inboundEmail.quarantineReason).toBe("DUPLICATE");
    expect(duplicate.createdJobIds).toHaveLength(0);
  });

  it("quarantines unknown/revoked/mismatched/auth-failed/malware without OCR", async () => {
    const s = await verifiedSetup();
    const beforeJobs = Number(executeSql("SELECT count(*) FROM app.processing_jobs;"));
    const cases = [
      {
        want: "UNKNOWN_TOKEN",
        value: payload({
          messageId: `0p-${runKey}-unknown`,
          recipient: "receipts+0123456789abcdef0123456789abcdef@inbound.test",
        }),
      },
      {
        want: "SENDER_MISMATCH",
        value: payload({
          messageId: `0p-${runKey}-mismatch`,
          recipient: s.token.routingAddress,
          sender: "attacker@example.test",
        }),
      },
      {
        want: "EMAIL_AUTH_FAILED",
        value: payload({
          messageId: `0p-${runKey}-authfail`,
          recipient: s.token.routingAddress,
          authPass: false,
        }),
      },
      {
        want: "MALWARE_DETECTED",
        value: payload({
          messageId: `0p-${runKey}-eicar`,
          recipient: s.token.routingAddress,
          bytes: pdf("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"),
        }),
      },
      {
        want: "INVALID_ATTACHMENT",
        value: payload({
          messageId: `0p-${runKey}-badmagic`,
          recipient: s.token.routingAddress,
          bytes: Buffer.from("not a pdf"),
        }),
      },
      {
        want: "UNSUPPORTED_ATTACHMENT",
        value: {
          ...payload({
            messageId: `0p-${runKey}-unsupported`,
            recipient: s.token.routingAddress,
          }),
          attachments: [{
            filename: "receipt.exe",
            contentType: "application/x-msdownload",
            dataBase64: Buffer.from("MZ").toString("base64"),
          }],
        },
      },
    ];
    for (const testCase of cases) {
      const result = await s.inbound.handleWebhook(testCase.value);
      expect(result.inboundEmail.status).toBe("QUARANTINED");
      expect(result.inboundEmail.quarantineReason).toBe(testCase.want);
      expect(result.createdFileIds).toHaveLength(0);
      expect(result.createdJobIds).toHaveLength(0);
    }

    const oldAddress = s.token.routingAddress;
    await s.inbound.rotateRoutingToken({
      actorUserId: s.userId,
      tenantId: s.tenantId,
      scope: s.scope,
      requestId: `0p-${runKey}-rotate-again`,
    });
    const revoked = await s.inbound.handleWebhook(
      payload({ messageId: `0p-${runKey}-revoked`, recipient: oldAddress }),
    );
    expect(revoked.inboundEmail.quarantineReason).toBe("TOKEN_REVOKED");
    expect(Number(executeSql("SELECT count(*) FROM app.processing_jobs;"))).toBe(beforeJobs);

    await s.inbound.dismissInboundEmail({
      actorUserId: s.userId,
      tenantId: s.tenantId,
      scope: s.scope,
      inboundEmailId: revoked.inboundEmail.id,
      requestId: `0p-${runKey}-dismiss`,
    });
    expect(
      executeSql(`SELECT status FROM app.inbound_emails WHERE id = '${revoked.inboundEmail.id}';`),
    ).toBe("DISMISSED");
  });

  it("rate-limits a valid token before file/job creation", async () => {
    const s = await verifiedSetup();
    for (let index = 0; index < 30; index += 1) {
      executeSql(`
        INSERT INTO app.inbound_emails
          (id, tenant_id, personal_profile_id, routing_token_id, provider_message_id,
           sender_email, recipient_address, content_hash, auth_results, status,
           quarantine_reason, attachment_count, total_bytes)
        VALUES
          ('${randomUUID()}', '${s.tenantId}', '${s.profileId}', '${s.token.id}',
           '0p-${runKey}-rate-seed-${index}', 'owner@example.test',
           '${s.token.routingAddress}', '${String(index).padStart(64, "0")}', '{}',
           'QUARANTINED', 'RATE_LIMITED', 0, 0);
      `);
    }
    const result = await s.inbound.handleWebhook(
      payload({ messageId: `0p-${runKey}-rate-final`, recipient: s.token.routingAddress }),
    );
    expect(result.inboundEmail.quarantineReason).toBe("RATE_LIMITED");
    expect(result.createdJobIds).toHaveLength(0);
  });
});
