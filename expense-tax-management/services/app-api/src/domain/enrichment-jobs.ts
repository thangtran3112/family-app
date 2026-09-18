import { randomUUID } from "node:crypto";

import {
  EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION,
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
  AI_WORKER_TASK_QUEUE,
  ExpenseEnrichmentResultV1Schema,
  type JobReferenceV1,
  type ExpenseEnrichmentInputResponseV1,
  type ExpenseEnrichmentInputV1,
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
 * Returns the created ProcessingJob for callers that need to inspect it.
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
): Promise<ProcessingJob> {
  const jobId = randomUUID();
  const workflowId = `job-${jobId}`;
  const now = new Date();

  const created = await transaction
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
    .returningAll()
    .executeTakeFirstOrThrow();

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

  return toProcessingJob(created);
}

// ------------------------------------------------------------------ //
// EnrichmentInputProjection — explicit seam for Task 6
// ------------------------------------------------------------------ //

/**
 * Task 6 injects a real projection by implementing this interface and wiring
 * it into createEnrichmentJobsDomain. Until Task 6 supplies the projection,
 * evaluate requests fail safely (CONFLICT) — stale/skipped proceed without
 * projection.
 */
export interface EnrichmentInputProjection {
  /**
   * Build the full ExpenseEnrichmentInputV1 for the given job and expense.
   * Called only when the job is RUNNING and the expense is ready and
   * version-current.
   * Task 6 implements eligible tag/category IDs and bounded history here.
   */
  buildInput(
    tenantId: string,
    jobId: string,
    expenseId: string,
    expenseVersion: number,
  ): Promise<ExpenseEnrichmentInputV1>;
}

/**
 * Sentinel projection used until Task 6 supplies the real implementation.
 * Throws CONFLICT for evaluate path so the worker retries rather than
 * receiving an invalid empty input.
 */
export const pendingProjection: EnrichmentInputProjection = {
  async buildInput() {
    throw DomainError.conflict();
  },
};

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

/**
 * Job status RUNNING is required for both input and result operations.
 * Worker must call the status update route (mark RUNNING) before requesting
 * input. DISPATCHED is rejected to enforce the spec flow order.
 */
const RUNNING_STATUS = "RUNNING" as const;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

export function createEnrichmentJobsDomain(
  database: Kysely<AppDatabase>,
  projection: EnrichmentInputProjection = pendingProjection,
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
        // I1: Only RUNNING is accepted; DISPATCHED is rejected (409).
        // Worker must mark RUNNING before reading input.
        if (job.status !== RUNNING_STATUS) {
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

        // Determine outcome before writing the audit event (I8).
        let outcome: "evaluate" | "stale" | "skipped";
        if (!expense || expense.status === "archived") {
          outcome = "skipped";
        } else if (
          job.expected_aggregate_version !== null &&
          expense.version !== job.expected_aggregate_version
        ) {
          outcome = "stale";
        } else {
          outcome = "evaluate";
        }

        // I8: audit after outcome is known; include evaluate/stale/skipped metadata.
        await recordAuditEvent(transaction, {
          tenantId: job.tenant_id,
          actorServicePrincipal: input.actorServicePrincipal,
          action: "processing_job.enrichment_input_read",
          outcome: "success",
          resourceType: "processing_job",
          resourceId: job.id,
          requestId: input.requestId,
          metadata: { inputOutcome: outcome },
        });

        if (outcome === "skipped") {
          return { outcome: "skipped" as const };
        }
        if (outcome === "stale") {
          return { outcome: "stale" as const };
        }

        // C3: Only evaluate reaches this path. Task 6's projection builds the
        // full input. Until then, pendingProjection throws CONFLICT safely.
        const evaluateInput = await projection.buildInput(
          job.tenant_id,
          job.id,
          expense!.id,
          expense!.version,
        );

        return { outcome: "evaluate" as const, input: evaluateInput };
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
            // I1: Only RUNNING accepted for result submission.
            if (job.status !== RUNNING_STATUS) {
              throw DomainError.conflict();
            }

            // Validate the result schema
            const parsed = ExpenseEnrichmentResultV1Schema.safeParse(input.result);
            if (!parsed.success) throw DomainError.validation();

            const outcome = parsed.data.outcome;

            // C2: Reject outcome:applied until Task 6 injects real application.
            // stale and skipped are safe no-mutation completions.
            if (outcome === "applied") {
              throw DomainError.conflict();
            }

            // stale/skipped: mark SUCCEEDED with empty result, no customer mutation.
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
// Strict transport schemas for HTTP body/response
// ------------------------------------------------------------------ //

/**
 * Transport-layer result schema for the enrichment result route body.
 *
 * This is a strict typed envelope that validates all required fields of
 * ExpenseEnrichmentResultV1 at HTTP layer WITHOUT the top-level `.refine()`
 * calls that would crash Fastify/ZodTypeProvider route registration.
 *
 * The domain performs a full canonical parse via ExpenseEnrichmentResultV1Schema
 * before acting on the result. Both layers must accept the same wire format;
 * this schema is a structural subset (no cross-field invariants).
 *
 * Registration proof: this schema is registered as a Fastify body schema in
 * registerJobRoutes; if it caused a crash, all job route tests would fail
 * with a startup error.
 *
 * Fastify/ZodTypeProvider limitation: top-level `.refine()` and
 * `.discriminatedUnion()` with cross-field `.refine()` cause
 * `isFluentSchema` undefined crashes during route setup in Fastify v5.
 * Equivalent plain `z.object` with `z.union`/`z.discriminatedUnion` (no
 * top-level refine) registers without issue and provides full field coverage.
 */
const SuggestionTransportSchema = z.union([
  z.object({
    kind: z.literal("tag"),
    source: z.literal("historical"),
    tagKey: z.string().min(1).max(100),
    confidence: z.number().min(0).max(1),
    evidenceHash: z.string().length(64),
    aggregateCounts: z.object({
      exampleCount: z.number().int().min(0).max(50),
      matchCount: z.number().int().min(0),
    }),
  }),
  z.object({
    kind: z.literal("spending_category"),
    source: z.literal("historical"),
    spendingCategoryId: z.string().uuid(),
    confidence: z.number().min(0).max(1),
    evidenceHash: z.string().length(64),
    aggregateCounts: z.object({
      exampleCount: z.number().int().min(0).max(50),
      matchCount: z.number().int().min(0),
    }),
  }),
  z.object({
    kind: z.literal("tax_category"),
    source: z.literal("historical"),
    taxCategoryDefinitionId: z.string().uuid(),
    businessTaxProfileId: z.string().uuid(),
    businessTaxProfileVersion: z.number().int().positive(),
    taxonomyVersionId: z.string().uuid(),
    taxYear: z.number().int().min(2000).max(2100),
    expenseVersion: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
    evidenceHash: z.string().length(64),
    aggregateCounts: z.object({
      exampleCount: z.number().int().min(0).max(50),
      matchCount: z.number().int().min(0),
    }),
  }),
]);

export const EnrichmentResultTransportSchema = z.object({
  schemaVersion: z.literal(1),
  rulesVersion: z.number().int().positive(),
  outcome: z.enum(["applied", "stale", "skipped"]),
  ruleTagKeys: z.array(z.string().min(1).max(100)).max(50),
  suggestions: z.array(SuggestionTransportSchema).max(50),
});

export const EnrichmentResultSubmitRequestSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().trim().min(1).max(255),
  expectedJobVersion: z.number().int().positive(),
  result: EnrichmentResultTransportSchema,
});
export type EnrichmentResultSubmitRequest = z.infer<typeof EnrichmentResultSubmitRequestSchema>;
