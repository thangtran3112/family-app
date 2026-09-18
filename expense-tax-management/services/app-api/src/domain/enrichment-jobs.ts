import { randomUUID } from "node:crypto";

import {
  EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION,
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
  AI_WORKER_TASK_QUEUE,
  ExpenseEnrichmentResultV1Schema,
  type JobReferenceV1,
  type ExpenseEnrichmentInputResponseV1,
  type ProcessingJob,
} from "@expense-tax/contracts";
import { type Kysely, type Transaction } from "kysely";
import { z } from "zod";

import type { AppDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import {
  executeIdempotentMutation,
  hashNormalizedRequest,
  toJsonValue,
  type MutationResult,
} from "./idempotency.js";
import { toProcessingJob } from "./processing-job-view.js";

// ------------------------------------------------------------------ //
// createEnrichmentJobInTransaction
// ------------------------------------------------------------------ //

export interface EnrichmentJobBinding {
  readonly tenantId: string;
  readonly scope:
    | { readonly personalProfileId: string; readonly businessId?: undefined }
    | { readonly businessId: string; readonly personalProfileId?: undefined };
  readonly expenseId: string;
  readonly expectedExpenseVersion: number;
  readonly requestedByUserId?: string;
  readonly requestId: string;
}

/**
 * Creates one enrichment processing job (version 1) + one dispatch outbox row
 * atomically inside the caller's transaction. Must be called only when the
 * expense is already inserted and status === "ready".
 *
 * Exported so ocr.ts can call it from applyOcrExtraction's transaction.
 * The caller owns the transaction boundary; this function must NOT open a
 * nested transaction.
 *
 * Note: inlined here (not delegating to createJobInTransaction) to avoid the
 * circular import processing-jobs -> ocr -> enrichment-jobs -> processing-jobs.
 */
export async function createEnrichmentJobInTransaction(
  transaction: Transaction<AppDatabase>,
  binding: EnrichmentJobBinding,
): Promise<void> {
  const jobId = randomUUID();
  const workflowId = `job-${jobId}`;
  const now = new Date();

  await transaction
    .insertInto("app.processing_jobs")
    .values({
      id: jobId,
      tenant_id: binding.tenantId,
      personal_profile_id: binding.scope.personalProfileId ?? null,
      business_id: binding.scope.businessId ?? null,
      workflow_type: EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
      workflow_id: workflowId,
      task_queue: AI_WORKER_TASK_QUEUE,
      run_id: null,
      status: "PENDING",
      target_aggregate_type: "expense",
      target_aggregate_id: binding.expenseId,
      expected_aggregate_version: binding.expectedExpenseVersion,
      requested_by_user_id: binding.requestedByUserId ?? null,
      source_file_id: null,
      input_params: toJsonValue({}),
      allowed_result_schema_version: EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION,
      result: null,
      error_message: null,
      version: 1,
      created_at: now,
      updated_at: now,
      dispatched_at: null,
      completed_at: null,
    })
    .execute();

  const jobReference: JobReferenceV1 = {
    schemaVersion: 1,
    jobId,
    workflowType: EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
    workflowId,
  };

  await transaction
    .insertInto("app.processing_job_dispatch_outbox")
    .values({
      id: randomUUID(),
      processing_job_id: jobId,
      job_reference: toJsonValue(jobReference),
      status: "PENDING",
      attempts: 0,
      last_error: null,
      created_at: now,
      dispatched_at: null,
    })
    .execute();

  await recordAuditEvent(transaction, {
    tenantId: binding.tenantId,
    actorUserId: binding.requestedByUserId ?? null,
    action: "processing_job.created",
    outcome: "success",
    resourceType: "processing_job",
    resourceId: jobId,
    requestId: binding.requestId,
  });
}

// ------------------------------------------------------------------ //
// EnrichmentJobsDomain — input and result routes
// ------------------------------------------------------------------ //

export interface GetEnrichmentInputCommand {
  readonly jobId: string;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

export interface SubmitEnrichmentResultCommand {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly expectedJobVersion: number;
  readonly result: unknown;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

export interface EnrichmentJobsDomain {
  getEnrichmentInput(
    input: GetEnrichmentInputCommand,
  ): Promise<ExpenseEnrichmentInputResponseV1>;
  submitEnrichmentResult(
    input: SubmitEnrichmentResultCommand,
  ): Promise<MutationResult<ProcessingJob, 200>>;
}

const RUNNING_STATUSES = ["DISPATCHED", "RUNNING"] as const;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

export function createEnrichmentJobsDomain(
  database: Kysely<AppDatabase>,
): EnrichmentJobsDomain {
  return {
    async getEnrichmentInput(input) {
      return database.transaction().execute(async (transaction) => {
        const job = await transaction
          .selectFrom("app.processing_jobs")
          .selectAll()
          .where("id", "=", input.jobId)
          .executeTakeFirst();

        if (!job || job.workflow_type !== EXPENSE_ENRICHMENT_WORKFLOW_TYPE) {
          throw DomainError.notFound();
        }
        if (job.allowed_result_schema_version !== EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION) {
          throw DomainError.notFound();
        }
        if (!RUNNING_STATUSES.includes(job.status as typeof RUNNING_STATUSES[number])) {
          throw DomainError.conflict();
        }
        if (!job.target_aggregate_id || job.target_aggregate_type !== "expense") {
          throw DomainError.validation();
        }

        // Fetch the target expense to check version / status
        const expense = await transaction
          .selectFrom("app.expenses")
          .selectAll()
          .where("id", "=", job.target_aggregate_id)
          .where("tenant_id", "=", job.tenant_id)
          .executeTakeFirst();

        await recordAuditEvent(transaction, {
          tenantId: job.tenant_id,
          actorServicePrincipal: input.actorServicePrincipal,
          action: "processing_job.enrichment_input_read",
          outcome: "success",
          resourceType: "processing_job",
          resourceId: job.id,
          requestId: input.requestId,
        });

        if (!expense) {
          return { outcome: "skipped" as const };
        }
        if (expense.status === "archived") {
          return { outcome: "skipped" as const };
        }
        if (
          job.expected_aggregate_version !== null &&
          expense.version !== job.expected_aggregate_version
        ) {
          return { outcome: "stale" as const };
        }

        // Task 6 owns full input projection. Return a job-bound stub for now
        // that Task 6 can implement without weakening validation seams.
        return {
          outcome: "evaluate" as const,
          input: {
            schemaVersion: 1 as const,
            jobId: job.id,
            expenseId: expense.id,
            expenseVersion: expense.version,
            normalizedMerchant: expense.merchant?.trim().toLowerCase() || null,
            incurredOn:
              typeof expense.incurred_on === "string"
                ? expense.incurred_on
                : expense.incurred_on instanceof Date
                  ? expense.incurred_on.toISOString().slice(0, 10)
                  : "1970-01-01",
            spendingCategoryId: expense.spending_category_id ?? null,
            rulesVersion: 1,
            eligibleTagKeys: [],
            eligibleSpendingCategoryIds: [],
            eligibleTaxSnapshot: null,
            history: {
              exampleCount: 0,
              candidateTagKeys: [],
              candidateSpendingCategoryIds: [],
              candidateTaxCategoryIds: [],
            },
          },
        };
      });
    },

    async submitEnrichmentResult(input) {
      try {
        return await executeIdempotentMutation(database, {
          actorKey: `service:${input.actorServicePrincipal}`,
          operationKey: "enrichment-job.result-submit",
          idempotencyKey: input.idempotencyKey,
          requestHash: hashNormalizedRequest({ jobId: input.jobId, result: input.result }),
          statusCode: 200,
          parseBody: (value) => value as ProcessingJob,
          execute: async (transaction) => {
            const job = await transaction
              .selectFrom("app.processing_jobs")
              .selectAll()
              .where("id", "=", input.jobId)
              .forUpdate()
              .executeTakeFirst();

            if (!job || job.workflow_type !== EXPENSE_ENRICHMENT_WORKFLOW_TYPE) {
              throw DomainError.notFound();
            }
            if (job.version !== input.expectedJobVersion) {
              throw DomainError.preconditionFailed();
            }
            if (!RUNNING_STATUSES.includes(job.status as typeof RUNNING_STATUSES[number])) {
              throw DomainError.conflict();
            }

            // Validate the result schema
            const parsed = ExpenseEnrichmentResultV1Schema.safeParse(input.result);
            if (!parsed.success) throw DomainError.validation();

            const outcome = parsed.data.outcome;
            // stale/skipped outcomes mark job SUCCEEDED with no customer mutation.
            // "applied" outcome: Task 6 owns full result application.
            // For now, all outcomes mark SUCCEEDED (no mutation placeholder).
            const now = new Date();
            const updated = await transaction
              .updateTable("app.processing_jobs")
              .set({
                status: "SUCCEEDED",
                result: toJsonValue(input.result as Record<string, unknown>),
                updated_at: now,
                completed_at: now,
                version: job.version + 1,
              })
              .where("id", "=", input.jobId)
              .returningAll()
              .executeTakeFirstOrThrow();

            await recordAuditEvent(transaction, {
              tenantId: job.tenant_id,
              actorServicePrincipal: input.actorServicePrincipal,
              action: "processing_job.enrichment_result_submitted",
              outcome: "success",
              resourceType: "processing_job",
              resourceId: input.jobId,
              requestId: input.requestId,
              metadata: { outcome },
            });

            return toProcessingJob(updated);
          },
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error)) throw DomainError.conflict();
        throw error;
      }
    },
  };
}

// ------------------------------------------------------------------ //
// Wire-format request schema for the result submission route
// ------------------------------------------------------------------ //

/**
 * Wire-format body schema for the enrichment result submission route.
 * The `result` field is typed as unknown here; domain validates it against
 * ExpenseEnrichmentResultV1Schema internally to avoid Fastify/ZodTypeProvider
 * issues with deeply nested discriminated-union schemas as body schemas.
 */
export const EnrichmentResultSubmitRequestSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().trim().min(1).max(255),
  expectedJobVersion: z.number().int().positive(),
  result: z.unknown(),
});
export type EnrichmentResultSubmitRequest = z.infer<typeof EnrichmentResultSubmitRequestSchema>;
