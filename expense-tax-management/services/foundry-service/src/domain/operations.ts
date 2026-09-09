import type {
  FoundryAuditEvent,
  ProviderCallLog,
  QuotaPeriod,
  ReconciliationQueueItem,
} from "@expense-tax/contracts";
import type { Kysely } from "kysely";
import type { FoundryDatabase } from "../database/types.js";

export interface OperationsDomain {
  listProviderCalls(limit: number): Promise<readonly ProviderCallLog[]>;
  listQuotaPeriods(limit: number): Promise<readonly QuotaPeriod[]>;
  listReconciliationQueue(limit: number): Promise<readonly ReconciliationQueueItem[]>;
  listAuditEvents(limit: number): Promise<readonly FoundryAuditEvent[]>;
}

function callView(row: {
  id: string; reservation_id: string; attempt_number: number; provider_idempotency_key: string | null;
  outcome: "accepted" | "failed" | "pending"; latency_ms: number | null; cost_usd: string | null; created_at: Date;
}) {
  return { id: row.id, reservationId: row.reservation_id, attemptNumber: row.attempt_number,
    providerIdempotencyKey: row.provider_idempotency_key, outcome: row.outcome,
    latencyMs: row.latency_ms, costUsd: row.cost_usd, createdAt: row.created_at.toISOString() };
}

export function createOperationsDomain(database: Kysely<FoundryDatabase>): OperationsDomain {
  return {
    async listProviderCalls(limit) {
      return (await database.selectFrom("foundry.provider_call_logs").selectAll().orderBy("created_at", "desc").limit(limit).execute()).map(callView);
    },
    async listQuotaPeriods(limit) {
      const rows = await database.selectFrom("foundry.ai_quota_periods as p")
        .innerJoin("foundry.tenant_ai_quotas as q", "q.id", "p.tenant_ai_quota_id")
        .select(["p.id", "p.tenant_ai_quota_id", "p.period_key", "p.consumed_jobs", "p.reserved_jobs", "p.updated_at", "q.tenant_id", "q.operation", "q.ai_model_id", "q.max_jobs"])
        .orderBy("p.updated_at", "desc").limit(limit).execute();
      return rows.map((row) => ({ id: row.id, tenantAiQuotaId: row.tenant_ai_quota_id, tenantId: row.tenant_id,
        operation: row.operation, aiModelId: row.ai_model_id, periodKey: row.period_key,
        consumedJobs: row.consumed_jobs, reservedJobs: row.reserved_jobs, maxJobs: row.max_jobs,
        updatedAt: row.updated_at.toISOString() }));
    },
    async listReconciliationQueue(limit) {
      const reservations = await database.selectFrom("foundry.ai_quota_reservations").selectAll()
        .where("status", "=", "RECONCILIATION_REQUIRED").orderBy("created_at", "asc").limit(limit).execute();
      const items = [];
      for (const reservation of reservations) {
        const attempts = await database.selectFrom("foundry.provider_call_logs").selectAll()
          .where("reservation_id", "=", reservation.id).orderBy("attempt_number").execute();
        const approvals = await database.selectFrom("foundry.ai_quota_reservation_resolutions")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("reservation_id", "=", reservation.id).where("decision", "=", "released").executeTakeFirstOrThrow();
        items.push({ reservationId: reservation.id, tenantId: reservation.tenant_id, operation: reservation.operation,
          aiModelId: reservation.ai_model_id, status: reservation.status, createdAt: reservation.created_at.toISOString(),
          callStartedAt: reservation.call_started_at?.toISOString() ?? null, attempts: attempts.map(callView),
          releasedApprovalCount: Number(approvals.count) });
      }
      return items;
    },
    async listAuditEvents(limit) {
      return (await database.selectFrom("foundry.foundry_audit_events").selectAll().orderBy("created_at", "desc").limit(limit).execute())
        .map((row) => ({ id: row.id, actorPlatformSubject: row.actor_platform_subject,
          actorServicePrincipal: row.actor_service_principal, action: row.action, outcome: row.outcome,
          resourceType: row.resource_type, resourceId: row.resource_id, requestId: row.request_id,
          createdAt: row.created_at.toISOString() }));
    },
  };
}
