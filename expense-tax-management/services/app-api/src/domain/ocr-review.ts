import {
  CaptureOcrReviewCompleteResponseV1Schema,
  CaptureOcrResultV1Schema,
  type CaptureOcrCompleteRequestV1,
  type CaptureOcrReviewCompleteResponseV1,
  type CaptureOcrReviewDetailV1,
  type CaptureOcrReviewItemV1,
  type CaptureOcrReviewListV1,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod";

import type { AppDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordCompletedOcrDeduplicationInTransaction } from "./deduplication.js";
import type { FileScope, FilesDomain } from "./files.js";
import { lockScopedReadyUnboundFile, requireScopeRole } from "./files.js";
import {
  executeIdempotentMutation,
  hashNormalizedRequest,
  toJsonValue,
  type MutationResult,
} from "./idempotency.js";
import { applyCaptureOcrResult } from "./ocr.js";
import { requireJobForUpdate } from "./processing-jobs.js";

interface ScopedReviewInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly scope: FileScope;
}

export interface ListOcrReviewsInput extends ScopedReviewInput {
  readonly status: "needs_input";
  readonly limit?: number;
  readonly cursor?: string;
}

export interface GetOcrReviewInput extends ScopedReviewInput {
  readonly jobId: string;
}

export interface CompleteOcrReviewInput extends GetOcrReviewInput {
  readonly request: CaptureOcrCompleteRequestV1;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface OcrReviewDomain {
  listReviews(input: ListOcrReviewsInput): Promise<CaptureOcrReviewListV1>;
  getReview(input: GetOcrReviewInput): Promise<CaptureOcrReviewDetailV1>;
  completeReview(
    input: CompleteOcrReviewInput,
  ): Promise<MutationResult<CaptureOcrReviewCompleteResponseV1, 200>>;
}

type ReviewJobRow = Selectable<AppDatabase["app.processing_jobs"]>;

const ReviewCursorSchema = z.strictObject({
  version: z.literal(1),
  tenantId: z.uuid(),
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("personal"), profileId: z.uuid() }),
    z.strictObject({ kind: z.literal("business"), businessId: z.uuid() }),
  ]),
  updatedAt: z.iso.datetime(),
  id: z.uuid(),
});

type ReviewCursor = z.infer<typeof ReviewCursorSchema>;

function encodeCursor(input: ScopedReviewInput, row: ReviewJobRow): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    tenantId: input.tenantId,
    scope: input.scope,
    updatedAt: row.updated_at.toISOString(),
    id: row.id,
  }), "utf8").toString("base64url");
}

function decodeCursor(value: string, input: ScopedReviewInput): ReviewCursor {
  try {
    const cursor = ReviewCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    const sameScope =
      cursor.scope.kind === "personal" && input.scope.kind === "personal"
        ? cursor.scope.profileId === input.scope.profileId
        : cursor.scope.kind === "business" && input.scope.kind === "business"
          ? cursor.scope.businessId === input.scope.businessId
          : false;
    if (cursor.tenantId !== input.tenantId || !sameScope) throw DomainError.validation();
    return cursor;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw DomainError.validation();
  }
}

function scopedReviewQuery(database: Kysely<AppDatabase>, input: ScopedReviewInput) {
  let query = database
    .selectFrom("app.processing_jobs")
    .selectAll()
    .where("tenant_id", "=", input.tenantId)
    .where("workflow_type", "=", "OcrReceiptWorkflow")
    .where("status", "=", "SUCCEEDED")
    .where("allowed_result_schema_version", "=", "capture-ocr-review-v1")
    .where("source_file_id", "is not", null)
    .where(sql<string>`result ->> 'outcome'`, "=", "needs_input");
  query = input.scope.kind === "personal"
    ? query.where("personal_profile_id", "=", input.scope.profileId).where("business_id", "is", null)
    : query.where("business_id", "=", input.scope.businessId).where("personal_profile_id", "is", null);
  return query;
}

function toReviewItem(row: ReviewJobRow): CaptureOcrReviewItemV1 {
  const result = CaptureOcrResultV1Schema.safeParse(row.result);
  if (!result.success || result.data.outcome !== "needs_input" || row.source_file_id === null) {
    throw DomainError.validation();
  }
  return {
    schemaVersion: 1,
    jobId: row.id,
    fileId: row.source_file_id,
    jobVersion: row.version,
    fields: result.data.fields,
    issues: result.data.issues,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createOcrReviewDomain(
  database: Kysely<AppDatabase>,
  dependencies: { readonly filesDomain: FilesDomain },
): OcrReviewDomain {
  return {
    async listReviews(input) {
      await requireScopeRole(database, input);
      const limit = input.limit ?? 50;
      let query = scopedReviewQuery(database, input)
        .orderBy("updated_at", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1);
      if (input.cursor !== undefined) {
        const cursor = decodeCursor(input.cursor, input);
        const updatedAt = new Date(cursor.updatedAt);
        query = query.where((eb) => eb.or([
          eb("updated_at", "<", updatedAt),
          eb.and([
            eb("updated_at", "=", updatedAt),
            eb("id", "<", cursor.id),
          ]),
        ]));
      }
      const rows = await query.execute();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        items: page.map(toReviewItem),
        nextCursor: hasMore ? encodeCursor(input, page[page.length - 1]!) : null,
      };
    },

    async getReview(input) {
      await requireScopeRole(database, input);
      const row = await scopedReviewQuery(database, input)
        .where("id", "=", input.jobId)
        .executeTakeFirst();
      if (!row) throw DomainError.notFound();
      const item = toReviewItem(row);
      const preview = await dependencies.filesDomain.issueFileReadUrl({
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: input.scope,
        fileId: item.fileId,
      });
      return {
        ...item,
        previewUrl: preview.url,
        previewExpiresAt: preview.expiresAt,
      };
    },

    async completeReview(input) {
      const role = await requireScopeRole(database, input);
      if (role !== "owner" && role !== "editor") throw DomainError.forbidden();
      const actorKey = `user:${input.actorUserId}`;
      const operationKey = "ocr-review.complete";
      const requestHash = hashNormalizedRequest({
        tenantId: input.tenantId,
        scope: input.scope,
        jobId: input.jobId,
        request: input.request,
      });
      return executeIdempotentMutation(database, {
        actorKey,
        operationKey,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        statusCode: 200,
        parseBody: (value) => CaptureOcrReviewCompleteResponseV1Schema.parse(value),
        execute: async (transaction) => {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actorKey}:${operationKey}:${input.idempotencyKey}`}, 0))`
            .execute(transaction);
          const racedReplay = await transaction
            .selectFrom("app.idempotency_records")
            .select(["request_hash", "response_body"])
            .where("actor_key", "=", actorKey)
            .where("operation_key", "=", operationKey)
            .where("idempotency_key", "=", input.idempotencyKey)
            .where("expires_at", ">", new Date())
            .executeTakeFirst();
          if (racedReplay) {
            if (racedReplay.request_hash !== requestHash) throw DomainError.conflict();
            return CaptureOcrReviewCompleteResponseV1Schema.parse(racedReplay.response_body);
          }

          const job = await requireJobForUpdate(transaction, input.jobId);
          if (job.tenant_id !== input.tenantId) throw DomainError.notFound();
          if (
            (input.scope.kind === "personal" &&
              (job.personal_profile_id !== input.scope.profileId || job.business_id !== null)) ||
            (input.scope.kind === "business" &&
              (job.business_id !== input.scope.businessId || job.personal_profile_id !== null))
          ) throw DomainError.notFound();
          if (
            job.workflow_type !== "OcrReceiptWorkflow" ||
            job.allowed_result_schema_version !== "capture-ocr-review-v1" ||
            (job.input_params as Record<string, unknown> | null)?.reviewPolicy !== "capture_required_fields_v1"
          ) throw DomainError.conflict();
          if (job.status !== "SUCCEEDED") throw DomainError.conflict();
          const priorResult = CaptureOcrResultV1Schema.safeParse(job.result);
          if (!priorResult.success || priorResult.data.outcome !== "needs_input") throw DomainError.conflict();
          if (job.version !== input.request.expectedJobVersion) throw DomainError.preconditionFailed();
          if (job.source_file_id === null || job.target_aggregate_id !== null) throw DomainError.conflict();
          const file = await lockScopedReadyUnboundFile(transaction, {
            tenantId: input.tenantId,
            scope: input.scope,
            fileId: job.source_file_id,
          });
          const taxAmount = input.request.tax.kind === "no_tax" ? "0.00" : input.request.tax.amount;
          const completedResult = CaptureOcrResultV1Schema.parse({
            schemaVersion: 1,
            outcome: "complete",
            fields: {
              merchant: input.request.merchant,
              total: input.request.total,
              currency: input.request.currency,
              incurredOn: input.request.incurredOn,
              taxAmount,
            },
          });
          const expenseId = await applyCaptureOcrResult(transaction, {
            job,
            result: completedResult,
            requestId: input.requestId,
          });
          if (expenseId === null) throw DomainError.validation();
          const updatedJob = await transaction
            .updateTable("app.processing_jobs")
            .set({
              result: toJsonValue(completedResult),
              target_aggregate_id: expenseId,
              version: job.version + 1,
              updated_at: new Date(),
            })
            .where("id", "=", job.id)
            .where("version", "=", job.version)
            .where("target_aggregate_id", "is", null)
            .returning(["id", "version"])
            .executeTakeFirst();
          if (!updatedJob) throw DomainError.conflict();
          const duplicate = await recordCompletedOcrDeduplicationInTransaction(transaction, {
            actorUserId: input.actorUserId,
            tenantId: input.tenantId,
            scope: input.scope,
            expenseId,
            fileId: file.id,
            merchant: input.request.merchant,
            amount: input.request.total,
            currency: input.request.currency,
            incurredOn: input.request.incurredOn,
            idempotencyKey: `${input.idempotencyKey}:dedup`,
            requestId: input.requestId,
          });
          return {
            schemaVersion: 1,
            jobId: updatedJob.id,
            expenseId,
            jobVersion: updatedJob.version,
            duplicateDecision: duplicate.decision,
            duplicateMatchIds: [...duplicate.matchIds],
          };
        },
      });
    },
  };
}
