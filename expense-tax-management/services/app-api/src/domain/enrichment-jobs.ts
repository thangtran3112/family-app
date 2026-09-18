import { randomUUID, createHash } from "node:crypto";

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
import {
  buildEnrichmentInput,
  applyEnrichmentResult,
} from "./enrichment.js";

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
// EnrichmentInputProjection — explicit seam (kept for test compatibility)
// ------------------------------------------------------------------ //

/**
 * Task 6 wired the real projection (buildEnrichmentInput from domain/enrichment.ts)
 * into createEnrichmentJobsDomain. This interface and pendingProjection are kept
 * for backward compatibility with existing tests in enrichment-domain.test.ts.
 *
 * The second parameter of createEnrichmentJobsDomain is no longer used in
 * production; the factory ignores it and always uses the real buildEnrichmentInput.
 */
export interface EnrichmentInputProjection {
  buildInput(
    tenantId: string,
    jobId: string,
    expenseId: string,
    expenseVersion: number,
  ): Promise<ExpenseEnrichmentInputV1>;
}

/**
 * Preserved for test compatibility (enrichment-domain.test.ts asserts this throws CONFLICT).
 * Not used in production after Task 6.
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
  // projection parameter kept for API compatibility; Task 6 uses buildEnrichmentInput directly.
  _projection: EnrichmentInputProjection = pendingProjection,
): EnrichmentJobsDomain {
  return {
    async getEnrichmentInput(input) {
      // I8: Audit is written inside buildEnrichmentInput's transaction for
      // evaluate path. For non-evaluate (stale/skipped), audit is below.
      const response = await buildEnrichmentInput(database, input.jobId);

      // Write audit event (we re-use the domain function's audit for evaluate;
      // here we add one for stale/skipped at the route level using the job id).
      // Note: buildEnrichmentInput writes audit inside its transaction for all
      // outcomes — but we need actorServicePrincipal. We add a second audit
      // event for the HTTP-layer actor attribution.
      await database.transaction().execute(async (transaction) => {
        await recordAuditEvent(transaction, {
          actorServicePrincipal: input.actorServicePrincipal,
          action: "processing_job.enrichment_input_served",
          outcome: "success",
          resourceType: "processing_job",
          resourceId: input.jobId,
          requestId: input.requestId,
          metadata: { servedOutcome: response.outcome },
        });
      });

      return response;
    },

    async submitEnrichmentResult(input) {
      // Canonical payload hash for permanent replay key.
      const payloadHash = hashNormalizedRequest({ jobId: input.jobId, result: input.result });

      // --- Step 1: Check permanent operation key (replay-safe; never expires) ---
      // Must be checked BEFORE the job-status guard so replay after generic
      // idempotency expiry returns the original response.
      const permanentOpKey = `result:${input.jobId}:${input.idempotencyKey}`;

      const permanentRecord = await database
        .selectFrom("app.enrichment_operation_keys")
        .select(["payload_hash", "response_json"])
        .where("operation_key", "=", permanentOpKey)
        .executeTakeFirst();

      if (permanentRecord) {
        if (permanentRecord.payload_hash !== payloadHash) {
          throw DomainError.conflict();
        }
        // Replay: parse stored response
        const stored = permanentRecord.response_json as Record<string, unknown>;
        return {
          statusCode: 200,
          body: stored as ProcessingJob,
          replayed: true,
        };
      }

      // --- Step 2: Generic idempotency (short-lived, 24h TTL) ---
      try {
        const result = await executeIdempotentMutation(database, {
          actorKey: `service:${input.actorServicePrincipal}`,
          operationKey: "enrichment-job.result-submit",
          idempotencyKey: input.idempotencyKey,
          requestHash: payloadHash,
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

            if (outcome === "stale" || outcome === "skipped") {
              // Safe no-mutation completion
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
            }

            // outcome === "applied": delegate to real application
            // applyEnrichmentResult opens its own transaction — we must NOT
            // be inside executeIdempotentMutation's transaction here.
            // Throw a sentinel to break out and call applyEnrichmentResult below.
            throw _AppliedSentinel;
          },
        });

        // Stale/skipped succeeded via idempotency — record permanent key
        await _recordPermanentResultKey(database, {
          tenantId: result.body.tenantId ?? "",
          jobId: input.jobId,
          expenseId: result.body.targetAggregateId ?? "",
          operationKey: permanentOpKey,
          payloadHash,
          responseJson: toJsonValue(result.body),
        });

        return result;
      } catch (error: unknown) {
        if (error === _AppliedSentinel) {
          // Route to real application (own transaction)
          const appliedResult = await applyEnrichmentResult(database, {
            jobId: input.jobId,
            idempotencyKey: input.idempotencyKey,
            expectedJobVersion: input.expectedJobVersion,
            result: input.result,
            actorServicePrincipal: input.actorServicePrincipal,
            requestId: input.requestId,
          });

          // Record permanent key after successful application
          await _recordPermanentResultKey(database, {
            tenantId: appliedResult.body.tenantId ?? "",
            jobId: input.jobId,
            expenseId: appliedResult.body.targetAggregateId ?? "",
            operationKey: permanentOpKey,
            payloadHash,
            responseJson: toJsonValue(appliedResult.body),
          });

          return appliedResult;
        }
        if (isUniqueViolation(error)) throw DomainError.conflict();
        throw error;
      }
    },
  };
}

/** Sentinel used to escape the idempotency wrapper for applied results. */
const _AppliedSentinel = Symbol("applied-sentinel");

async function _recordPermanentResultKey(
  database: Kysely<AppDatabase>,
  input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly expenseId: string;
    readonly operationKey: string;
    readonly payloadHash: string;
    readonly responseJson: import("../database/types.js").JsonValue;
  },
): Promise<void> {
  const existing = await database
    .selectFrom("app.enrichment_operation_keys")
    .select("payload_hash")
    .where("operation_key", "=", input.operationKey)
    .executeTakeFirst();

  if (existing) {
    if (existing.payload_hash !== input.payloadHash) throw DomainError.conflict();
    return; // Already recorded
  }

  try {
    await database
      .insertInto("app.enrichment_operation_keys")
      .values({
        id: randomUUID(),
        tenant_id: input.tenantId,
        job_id: input.jobId,
        expense_id: input.expenseId,
        kind: "tag", // job-level result key uses "tag" kind as placeholder
        candidate_id: null,
        evidence_hash: createHash("sha256").update(input.payloadHash).digest("hex"),
        operation_key: input.operationKey,
        payload_hash: input.payloadHash,
        response_json: input.responseJson,
        created_at: new Date(),
      })
      .execute();
  } catch (err: unknown) {
    // Unique violation on (tenant_id, operation_key) — already recorded, safe to ignore
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "23505"
    ) {
      return;
    }
    throw err;
  }
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
/** Exact canonical lowercase SHA-256 regex — 64 hex chars, lowercase only. */
const EvidenceHashTransportSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "evidenceHash must be a 64-char lowercase hex SHA-256");

const AggregateCounts = z.strictObject({
  exampleCount: z.number().int().min(0).max(50),
  matchCount: z.number().int().min(0),
});

const SuggestionTransportSchema = z.union([
  z.strictObject({
    kind: z.literal("tag"),
    source: z.literal("historical"),
    tagKey: z.string().min(1).max(100),
    confidence: z.number().min(0).max(1),
    evidenceHash: EvidenceHashTransportSchema,
    aggregateCounts: AggregateCounts,
  }),
  z.strictObject({
    kind: z.literal("spending_category"),
    source: z.literal("historical"),
    spendingCategoryId: z.string().uuid(),
    confidence: z.number().min(0).max(1),
    evidenceHash: EvidenceHashTransportSchema,
    aggregateCounts: AggregateCounts,
  }),
  z.strictObject({
    kind: z.literal("tax_category"),
    source: z.literal("historical"),
    taxCategoryDefinitionId: z.string().uuid(),
    businessTaxProfileId: z.string().uuid(),
    businessTaxProfileVersion: z.number().int().positive(),
    taxonomyVersionId: z.string().uuid(),
    taxYear: z.number().int().min(2000).max(2100),
    expenseVersion: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
    evidenceHash: EvidenceHashTransportSchema,
    aggregateCounts: AggregateCounts,
  }),
]);

export const EnrichmentResultTransportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rulesVersion: z.number().int().positive(),
  outcome: z.enum(["applied", "stale", "skipped"]),
  ruleTagKeys: z.array(z.string().min(1).max(100)).max(50),
  suggestions: z.array(SuggestionTransportSchema).max(50),
});

export const EnrichmentResultSubmitRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().trim().min(1).max(255),
  expectedJobVersion: z.number().int().positive(),
  result: EnrichmentResultTransportSchema,
});
export type EnrichmentResultSubmitRequest = z.infer<typeof EnrichmentResultSubmitRequestSchema>;
