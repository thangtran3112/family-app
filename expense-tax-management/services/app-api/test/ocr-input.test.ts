/**
 * OcrJobsDomain.getOcrInput against a Kysely whose driver answers from
 * canned rows (no PostgreSQL). The worker's mailbox_ocr_receipt activity
 * reads its input through this generic route, and the workflow-type
 * allowlist once answered 404 for MailboxOcrReceiptWorkflow jobs, so no
 * Gmail attachment could ever reach OCR.
 */
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";

import type { AppDatabase } from "../src/database/types.js";
import { applyCaptureOcrResult, createOcrJobsDomain } from "../src/domain/ocr.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const SHA256 = "a".repeat(64);

function databaseWithJob(
  workflowType: string,
  reviewPolicy?: "capture_required_fields_v1",
): Kysely<AppDatabase> {
  const job = {
    id: JOB_ID,
    tenant_id: TENANT_ID,
    workflow_type: workflowType,
    status: "RUNNING",
    source_file_id: FILE_ID,
    input_params: {
      modeKey: "ocr_mode_fast",
      ...(reviewPolicy === undefined ? {} : { reviewPolicy }),
    },
  };
  const file = { id: FILE_ID, sha256_hex: SHA256 };
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const rows = query.sql.includes('"app"."processing_jobs"')
        ? [job]
        : query.sql.includes('"app"."expense_files"')
          ? [file]
          : [];
      return { rows: rows as R[] };
    },
    streamQuery() {
      throw new Error("not used");
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  return new Kysely<AppDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

function getOcrInput(
  workflowType: string,
  reviewPolicy?: "capture_required_fields_v1",
) {
  const domain = createOcrJobsDomain(databaseWithJob(workflowType, reviewPolicy), {} as never);
  return domain.getOcrInput({ jobId: JOB_ID, actorServicePrincipal: "ai-worker", requestId: "request-1" });
}

describe("OcrJobsDomain.getOcrInput", () => {
  it.each(["OcrReceiptWorkflow", "ForwardedReceiptWorkflow", "MailboxOcrReceiptWorkflow"])(
    "returns the file, mode and hash for a running %s job",
    async (workflowType) => {
      await expect(getOcrInput(workflowType)).resolves.toEqual({
        schemaVersion: 1,
        fileId: FILE_ID,
        modeKey: "ocr_mode_fast",
        expectedSha256: SHA256,
        tenantId: TENANT_ID,
      });
    },
  );

  it("still answers not found for a job of any other workflow type", async () => {
    await expect(getOcrInput("MailboxMaterializeWorkflow")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("round-trips the persisted Capture review policy", async () => {
    await expect(getOcrInput("OcrReceiptWorkflow", "capture_required_fields_v1")).resolves.toEqual({
      schemaVersion: 1,
      fileId: FILE_ID,
      modeKey: "ocr_mode_fast",
      expectedSha256: SHA256,
      tenantId: TENANT_ID,
      reviewPolicy: "capture_required_fields_v1",
    });
  });

  it("does not touch expense persistence for a Capture needs-input result", async () => {
    const transaction = new Proxy({}, {
      get() { throw new Error("database must not be touched"); },
    });
    await expect(applyCaptureOcrResult(transaction as never, {
      job: {} as never,
      result: {
        schemaVersion: 1,
        outcome: "needs_input",
        fields: {
          merchant: "Acme",
          total: "10.00",
          currency: "USD",
          incurredOn: null,
          taxAmount: "0.00",
        },
        issues: ["date_missing", "tax_zero_requires_confirmation"],
      },
      requestId: "request-1",
    })).resolves.toBeNull();
  });
});
