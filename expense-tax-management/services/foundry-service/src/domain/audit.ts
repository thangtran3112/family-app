import { randomUUID } from "node:crypto";

import type { Transaction } from "kysely";

import type { FoundryDatabase } from "../database/types.js";

export interface AuditEventInput {
  readonly actorPlatformSubject?: string | null;
  readonly actorServicePrincipal?: string | null;
  readonly action: string;
  readonly outcome: "success" | "denied" | "failure";
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly requestId: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export async function recordAuditEvent(
  transaction: Transaction<FoundryDatabase>,
  input: AuditEventInput,
): Promise<void> {
  await transaction
    .insertInto("foundry.foundry_audit_events")
    .values({
      id: randomUUID(),
      actor_platform_subject: input.actorPlatformSubject ?? null,
      actor_service_principal: input.actorServicePrincipal ?? null,
      action: input.action,
      outcome: input.outcome,
      resource_type: input.resourceType,
      resource_id: input.resourceId ?? null,
      request_id: input.requestId,
      metadata: input.metadata ?? {},
    })
    .execute();
}
