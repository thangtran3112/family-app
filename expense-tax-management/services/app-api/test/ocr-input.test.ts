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
import { createProcessingJobsDomain } from "../src/domain/processing-jobs.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";
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

function compiledInsertRow(query: CompiledQuery): Record<string, unknown> {
  const columns = query.sql.match(/^insert into [^(]+\(([^)]+)\)/)?.[1]
    ?.split(",")
    .map((column) => column.trim().replaceAll('"', ""));
  if (!columns) throw new Error(`Unexpected insert query: ${query.sql}`);
  return Object.fromEntries(columns.map((column, index) => [column, query.parameters[index]]));
}

function compiledUpdateValues(query: CompiledQuery): Record<string, unknown> {
  const assignments = query.sql.match(/ set (.+?) where /)?.[1]?.split(",");
  if (!assignments) throw new Error(`Unexpected update query: ${query.sql}`);
  return Object.fromEntries(assignments.map((assignment, index) => {
    const column = assignment.split("=")[0]?.trim().replaceAll('"', "");
    if (!column) throw new Error(`Unexpected update assignment: ${assignment}`);
    return [column, query.parameters[index]];
  }));
}

function databaseForCompleteCapture(insertedExpenses: Record<string, unknown>[]): Kysely<AppDatabase> {
  const now = new Date("2026-10-18T00:00:00.000Z");
  let job = {
    id: JOB_ID,
    tenant_id: TENANT_ID,
    personal_profile_id: PROFILE_ID,
    business_id: null,
    workflow_type: "OcrReceiptWorkflow",
    workflow_id: `job-${JOB_ID}`,
    task_queue: "expense-tax-processing",
    dispatch_generation: 2,
    dispatch_namespace: "expense-tax",
    run_id: "run-1",
    status: "RUNNING",
    target_aggregate_type: "expense",
    target_aggregate_id: null,
    expected_aggregate_version: null,
    requested_by_user_id: USER_ID,
    source_file_id: FILE_ID,
    input_params: { modeKey: "ocr_mode_fast", reviewPolicy: "capture_required_fields_v1" },
    allowed_result_schema_version: "capture-ocr-review-v1",
    result: null,
    error_message: null,
    version: 3,
    created_at: now,
    updated_at: now,
    dispatched_at: now,
    completed_at: null,
  };
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      if (query.sql.includes('from "app"."idempotency_records"')) return { rows: [] };
      if (query.sql.includes('from "app"."processing_jobs"')) return { rows: [job] as R[] };
      if (query.sql.includes('from "app"."expense_files"')) {
        return {
          rows: [{
            id: FILE_ID,
            tenant_id: TENANT_ID,
            personal_profile_id: PROFILE_ID,
            business_id: null,
            expense_id: null,
          }] as R[],
        };
      }
      if (query.sql.startsWith('insert into "app"."expenses"')) {
        const inserted = compiledInsertRow(query);
        insertedExpenses.push(inserted);
        return {
          rows: [{ ...inserted, tax_year: 2026 }] as R[],
        };
      }
      if (query.sql.includes('from "app"."temporal_dispatch_routing"')) {
        return {
          rows: [{ generation: 2, temporal_namespace: "expense-tax", task_queue: "expense-tax-processing" }] as R[],
        };
      }
      if (query.sql.startsWith('insert into "app"."processing_jobs"')) {
        return { rows: [compiledInsertRow(query)] as R[] };
      }
      if (query.sql.startsWith('update "app"."processing_jobs"')) {
        job = { ...job, ...compiledUpdateValues(query) };
        return { rows: [job] as R[] };
      }
      return { rows: [] };
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

  it("persists a complete Capture total and tax amount as a new expense", async () => {
    const insertedExpenses: Record<string, unknown>[] = [];
    const database = databaseForCompleteCapture(insertedExpenses);
    const domain = createProcessingJobsDomain(database, {
      start: async () => ({ runId: "unused" }),
      close: async () => undefined,
    });

    const result = await domain.submitResult({
      jobId: JOB_ID,
      actorServicePrincipal: "workflow-worker",
      requestId: "request-2",
      request: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: "capture-complete-1",
        expectedJobVersion: 3,
        resultSchemaVersion: "capture-ocr-review-v1",
        result: {
          schemaVersion: 1,
          outcome: "complete",
          fields: {
            merchant: "Acme",
            total: "42.50",
            currency: "USD",
            incurredOn: "2026-10-18",
            taxAmount: "5.53",
          },
        },
      },
    });

    expect(result.body.status).toBe("SUCCEEDED");
    expect(insertedExpenses).toHaveLength(1);
    expect(insertedExpenses[0]).toMatchObject({
      merchant: "Acme",
      amount: "42.50",
      tax_amount: "5.53",
      currency: "USD",
      incurred_on: "2026-10-18",
      source: "ocr",
    });
  });
});
