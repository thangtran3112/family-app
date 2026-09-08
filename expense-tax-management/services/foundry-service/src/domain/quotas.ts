import { randomUUID } from "node:crypto";

import type {
  AiOperation,
  AiQuotaReservation,
  AiQuotaReservationCreateRequest,
  ProviderCallOutcomeRequest,
  ProviderCallStartedRequest,
  QuotaStatusResponse,
  ReconciliationResolveRequest,
  TenantAiQuota,
  TenantAiQuotaCreateRequest,
} from "@expense-tax/contracts";
import type { Kysely, Selectable, Transaction } from "kysely";

import type { FoundryDatabase, JsonValue } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";

interface ActorContext {
  readonly requestId: string;
}

export interface QuotasDomain {
  createTenantAiQuota(
    input: ActorContext & {
      readonly actorPlatformSubject: string;
      readonly request: TenantAiQuotaCreateRequest;
    },
  ): Promise<TenantAiQuota>;
  listTenantAiQuotas(): Promise<readonly TenantAiQuota[]>;
  reserve(
    input: ActorContext & { readonly request: AiQuotaReservationCreateRequest },
  ): Promise<AiQuotaReservation>;
  recordCallAttempt(
    input: ActorContext & {
      readonly reservationId: string;
      readonly request: ProviderCallStartedRequest;
    },
  ): Promise<{ readonly reservation: AiQuotaReservation; readonly attemptNumber: number }>;
  recordProviderOutcome(
    input: ActorContext & {
      readonly reservationId: string;
      readonly attemptNumber: number;
      readonly request: ProviderCallOutcomeRequest;
    },
  ): Promise<AiQuotaReservation>;
  markReconciliationRequired(
    input: ActorContext & { readonly reservationId: string },
  ): Promise<AiQuotaReservation>;
  release(
    input: ActorContext & { readonly reservationId: string },
  ): Promise<AiQuotaReservation>;
  resolveReconciliation(
    input: ActorContext & {
      readonly reservationId: string;
      readonly resolvedBySubject: string;
      readonly request: ReconciliationResolveRequest;
    },
  ): Promise<AiQuotaReservation>;
  getQuotaStatus(input: {
    readonly tenantId: string;
    readonly operation: AiOperation;
  }): Promise<QuotaStatusResponse>;
}

function toTenantAiQuota(
  row: Selectable<FoundryDatabase["foundry.tenant_ai_quotas"]>,
): TenantAiQuota {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    operation: row.operation,
    aiModelId: row.ai_model_id,
    periodType: row.period_type,
    maxJobs: row.max_jobs,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toReservation(
  row: Selectable<FoundryDatabase["foundry.ai_quota_reservations"]>,
): AiQuotaReservation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    operation: row.operation,
    aiModelId: row.ai_model_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    callStartedAt: row.call_started_at ? row.call_started_at.toISOString() : null,
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

function isPostgresError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === code
  );
}

async function runInsert<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    if (isPostgresError(error, "23505")) throw DomainError.conflict();
    if (isPostgresError(error, "23503")) throw DomainError.validation();
    if (isPostgresError(error, "23514")) throw DomainError.validation();
    throw error;
  }
}

/** UTC calendar-month key, e.g. "2026-09". The only period granularity this wave supports. */
function currentPeriodKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Start of the next UTC calendar month -- when a 'monthly' period resets. */
function nextPeriodResetAt(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

async function ensurePeriodLocked(
  transaction: Transaction<FoundryDatabase>,
  tenantAiQuotaId: string,
  periodKey: string,
): Promise<Selectable<FoundryDatabase["foundry.ai_quota_periods"]>> {
  await transaction
    .insertInto("foundry.ai_quota_periods")
    .values({ id: randomUUID(), tenant_ai_quota_id: tenantAiQuotaId, period_key: periodKey })
    .onConflict((conflict) => conflict.columns(["tenant_ai_quota_id", "period_key"]).doNothing())
    .execute();
  return await transaction
    .selectFrom("foundry.ai_quota_periods")
    .selectAll()
    .where("tenant_ai_quota_id", "=", tenantAiQuotaId)
    .where("period_key", "=", periodKey)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

async function findPolicy(
  database: Kysely<FoundryDatabase> | Transaction<FoundryDatabase>,
  tenantId: string,
  operation: AiOperation,
  aiModelId: string | null,
): Promise<Selectable<FoundryDatabase["foundry.tenant_ai_quotas"]> | undefined> {
  let query = database
    .selectFrom("foundry.tenant_ai_quotas")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("operation", "=", operation);
  query = aiModelId === null
    ? query.where("ai_model_id", "is", null)
    : query.where("ai_model_id", "=", aiModelId);
  return await query.executeTakeFirst();
}

/**
 * Checks and reserves capacity against one policy's current period,
 * inside the caller's transaction. Returns the locked period's id, or
 * null if no policy applies at this scope (nothing to check/reserve).
 * Throws DomainError.conflict() if the policy is capped and exhausted.
 */
async function checkAndReserve(
  transaction: Transaction<FoundryDatabase>,
  policy: Selectable<FoundryDatabase["foundry.tenant_ai_quotas"]> | undefined,
): Promise<string | null> {
  if (!policy) return null;
  if (policy.period_type === "unlimited" || policy.max_jobs === null) return null;

  const period = await ensurePeriodLocked(transaction, policy.id, currentPeriodKey());
  if (period.consumed_jobs + period.reserved_jobs >= policy.max_jobs) {
    throw DomainError.conflict();
  }
  await transaction
    .updateTable("foundry.ai_quota_periods")
    .set((eb) => ({ reserved_jobs: eb("reserved_jobs", "+", 1), updated_at: new Date() }))
    .where("id", "=", period.id)
    .execute();
  return period.id;
}

async function releasePeriodSlot(
  transaction: Transaction<FoundryDatabase>,
  periodId: string | null,
): Promise<void> {
  if (!periodId) return;
  await transaction
    .updateTable("foundry.ai_quota_periods")
    .set((eb) => ({ reserved_jobs: eb("reserved_jobs", "-", 1), updated_at: new Date() }))
    .where("id", "=", periodId)
    .execute();
}

async function consumePeriodSlot(
  transaction: Transaction<FoundryDatabase>,
  periodId: string | null,
): Promise<void> {
  if (!periodId) return;
  await transaction
    .updateTable("foundry.ai_quota_periods")
    .set((eb) => ({
      reserved_jobs: eb("reserved_jobs", "-", 1),
      consumed_jobs: eb("consumed_jobs", "+", 1),
      updated_at: new Date(),
    }))
    .where("id", "=", periodId)
    .execute();
}

async function requireReservation(
  transaction: Transaction<FoundryDatabase>,
  reservationId: string,
): Promise<Selectable<FoundryDatabase["foundry.ai_quota_reservations"]>> {
  const reservation = await transaction
    .selectFrom("foundry.ai_quota_reservations")
    .selectAll()
    .where("id", "=", reservationId)
    .forUpdate()
    .executeTakeFirst();
  if (!reservation) throw DomainError.notFound();
  return reservation;
}

export function createQuotasDomain(database: Kysely<FoundryDatabase>): QuotasDomain {
  return {
    async createTenantAiQuota(input) {
      return runInsert(() =>
        database.transaction().execute(async (transaction) => {
          const created = await transaction
            .insertInto("foundry.tenant_ai_quotas")
            .values({
              id: randomUUID(),
              tenant_id: input.request.tenantId,
              operation: input.request.operation,
              ai_model_id: input.request.aiModelId ?? null,
              period_type: input.request.periodType,
              max_jobs: input.request.maxJobs,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAuditEvent(transaction, {
            actorPlatformSubject: input.actorPlatformSubject,
            action: "tenant_ai_quota.created",
            outcome: "success",
            resourceType: "tenant_ai_quota",
            resourceId: created.id,
            requestId: input.requestId,
          });
          return toTenantAiQuota(created);
        }),
      );
    },
    async listTenantAiQuotas() {
      const rows = await database.selectFrom("foundry.tenant_ai_quotas").selectAll().execute();
      return rows.map(toTenantAiQuota);
    },
    async reserve(input) {
      return runInsert(() =>
        database.transaction().execute(async (transaction) => {
          const { tenantId, operation, aiModelId } = input.request;
          const aggregatePolicy = await findPolicy(transaction, tenantId, operation, null);
          const modelPolicy = await findPolicy(transaction, tenantId, operation, aiModelId);

          // Aggregate checked first and cannot be bypassed by a model-scoped
          // allowance (design doc: "Model/route switching cannot bypass the
          // aggregate allowance"). Throwing rolls back any partial increment.
          const aggregatePeriodId = await checkAndReserve(transaction, aggregatePolicy);
          const modelPeriodId = await checkAndReserve(transaction, modelPolicy);

          const created = await transaction
            .insertInto("foundry.ai_quota_reservations")
            .values({
              id: randomUUID(),
              tenant_id: tenantId,
              operation,
              ai_model_id: aiModelId,
              idempotency_key: input.request.idempotencyKey,
              aggregate_period_id: aggregatePeriodId,
              model_period_id: modelPeriodId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return toReservation(created);
        }),
      );
    },
    async recordCallAttempt(input) {
      return database.transaction().execute(async (transaction) => {
        const reservation = await requireReservation(transaction, input.reservationId);
        // CONSUMED stays loggable: supplementary calls after acceptance are
        // telemetry-only (design doc), so a worker retrying/logging extra
        // attempts post-acceptance must not be rejected. RELEASED and
        // RECONCILIATION_REQUIRED are the true terminal states -- no new
        // provider call should start once either applies.
        if (
          reservation.status !== "RESERVED" &&
          reservation.status !== "CALL_STARTED" &&
          reservation.status !== "CONSUMED"
        ) {
          throw DomainError.conflict();
        }

        const latestAttempt = await transaction
          .selectFrom("foundry.provider_call_logs")
          .select(({ fn }) => fn.max("attempt_number").as("max_attempt"))
          .where("reservation_id", "=", input.reservationId)
          .executeTakeFirst();
        const attemptNumber = (latestAttempt?.max_attempt ?? 0) + 1;

        await transaction
          .insertInto("foundry.provider_call_logs")
          .values({
            id: randomUUID(),
            reservation_id: input.reservationId,
            attempt_number: attemptNumber,
            provider_idempotency_key: input.request.providerIdempotencyKey ?? null,
          })
          .execute();

        const updated =
          reservation.status === "RESERVED"
            ? await transaction
                .updateTable("foundry.ai_quota_reservations")
                .set({ status: "CALL_STARTED", call_started_at: new Date(), updated_at: new Date() })
                .where("id", "=", input.reservationId)
                .returningAll()
                .executeTakeFirstOrThrow()
            : reservation;
        return { reservation: toReservation(updated), attemptNumber };
      });
    },
    async recordProviderOutcome(input) {
      return database.transaction().execute(async (transaction) => {
        const reservation = await requireReservation(transaction, input.reservationId);
        const attempt = await transaction
          .selectFrom("foundry.provider_call_logs")
          .selectAll()
          .where("reservation_id", "=", input.reservationId)
          .where("attempt_number", "=", input.attemptNumber)
          .executeTakeFirst();
        if (!attempt) throw DomainError.notFound();

        await transaction
          .updateTable("foundry.provider_call_logs")
          .set({
            outcome: input.request.outcome,
            latency_ms: input.request.latencyMs ?? null,
            cost_usd: input.request.costUsd ?? null,
          })
          .where("id", "=", attempt.id)
          .execute();

        // Only the FIRST accepted attempt while still CALL_STARTED consumes
        // credit; later attempts (retries after acceptance, or outcome
        // updates after this reservation already reached a terminal state)
        // are telemetry-only, matching design doc "Supporting retries...
        // do not consume another product credit."
        if (input.request.outcome === "accepted" && reservation.status === "CALL_STARTED") {
          await consumePeriodSlot(transaction, reservation.aggregate_period_id);
          await consumePeriodSlot(transaction, reservation.model_period_id);
          const updated = await transaction
            .updateTable("foundry.ai_quota_reservations")
            .set({ status: "CONSUMED", resolved_at: new Date(), updated_at: new Date() })
            .where("id", "=", input.reservationId)
            .returningAll()
            .executeTakeFirstOrThrow();
          return toReservation(updated);
        }
        return toReservation(reservation);
      });
    },
    async markReconciliationRequired(input) {
      return database.transaction().execute(async (transaction) => {
        const updated = await transaction
          .updateTable("foundry.ai_quota_reservations")
          .set({ status: "RECONCILIATION_REQUIRED", updated_at: new Date() })
          .where("id", "=", input.reservationId)
          .where("status", "=", "CALL_STARTED")
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();
        return toReservation(updated);
      });
    },
    async release(input) {
      return database.transaction().execute(async (transaction) => {
        const reservation = await requireReservation(transaction, input.reservationId);
        if (reservation.status !== "RESERVED") throw DomainError.conflict();

        await releasePeriodSlot(transaction, reservation.aggregate_period_id);
        await releasePeriodSlot(transaction, reservation.model_period_id);
        const updated = await transaction
          .updateTable("foundry.ai_quota_reservations")
          .set({ status: "RELEASED", resolved_at: new Date(), updated_at: new Date() })
          .where("id", "=", input.reservationId)
          .returningAll()
          .executeTakeFirstOrThrow();
        return toReservation(updated);
      });
    },
    async resolveReconciliation(input) {
      return runInsert(() =>
        database.transaction().execute(async (transaction) => {
          const reservation = await requireReservation(transaction, input.reservationId);
          if (reservation.status !== "RECONCILIATION_REQUIRED") {
            throw DomainError.conflict();
          }

          await transaction
            .insertInto("foundry.ai_quota_reservation_resolutions")
            .values({
              id: randomUUID(),
              reservation_id: input.reservationId,
              decision: input.request.decision,
              reason: input.request.reason,
              evidence: (input.request.evidence ?? null) as JsonValue | null,
              resolved_by_subject: input.resolvedBySubject,
            })
            .execute();
          await recordAuditEvent(transaction, {
            actorPlatformSubject: input.resolvedBySubject,
            action: "ai_quota_reservation.resolution_submitted",
            outcome: "success",
            resourceType: "ai_quota_reservation",
            resourceId: input.reservationId,
            requestId: input.requestId,
            metadata: { decision: input.request.decision },
          });

          if (input.request.decision === "consumed") {
            await consumePeriodSlot(transaction, reservation.aggregate_period_id);
            await consumePeriodSlot(transaction, reservation.model_period_id);
            const updated = await transaction
              .updateTable("foundry.ai_quota_reservations")
              .set({ status: "CONSUMED", resolved_at: new Date(), updated_at: new Date() })
              .where("id", "=", input.reservationId)
              .returningAll()
              .executeTakeFirstOrThrow();
            return toReservation(updated);
          }

          // 'released' requires a second approval from a DIFFERENT subject
          // (design doc: "Ambiguous release requires dual approval").
          const releaseApprovals = await transaction
            .selectFrom("foundry.ai_quota_reservation_resolutions")
            .select("resolved_by_subject")
            .where("reservation_id", "=", input.reservationId)
            .where("decision", "=", "released")
            .execute();
          const distinctApprovers = new Set(releaseApprovals.map((row) => row.resolved_by_subject));
          if (distinctApprovers.size < 2) {
            return toReservation(reservation);
          }

          await releasePeriodSlot(transaction, reservation.aggregate_period_id);
          await releasePeriodSlot(transaction, reservation.model_period_id);
          const updated = await transaction
            .updateTable("foundry.ai_quota_reservations")
            .set({ status: "RELEASED", resolved_at: new Date(), updated_at: new Date() })
            .where("id", "=", input.reservationId)
            .returningAll()
            .executeTakeFirstOrThrow();
          return toReservation(updated);
        }),
      );
    },
    async getQuotaStatus(input) {
      const policy = await findPolicy(database, input.tenantId, input.operation, null);
      if (!policy) {
        return { isAvailable: false, remainingJobs: null, resetsAt: null };
      }
      if (policy.period_type === "unlimited" || policy.max_jobs === null) {
        return { isAvailable: true, remainingJobs: null, resetsAt: null };
      }
      const period = await database
        .selectFrom("foundry.ai_quota_periods")
        .selectAll()
        .where("tenant_ai_quota_id", "=", policy.id)
        .where("period_key", "=", currentPeriodKey())
        .executeTakeFirst();
      const used = (period?.consumed_jobs ?? 0) + (period?.reserved_jobs ?? 0);
      const remaining = Math.max(policy.max_jobs - used, 0);
      return {
        isAvailable: remaining > 0,
        remainingJobs: remaining,
        resetsAt: nextPeriodResetAt().toISOString(),
      };
    },
  };
}
