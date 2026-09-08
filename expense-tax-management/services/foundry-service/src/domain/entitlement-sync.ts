import { randomUUID } from "node:crypto";

import { createAppApiClient, type AiOperation } from "@expense-tax/contracts";
import type { Kysely } from "kysely";

import type { FoundryDatabase } from "../database/types.js";

const SYNC_CURSOR_KEY = "entitlement_sync_cursor";

export interface EntitlementSyncOptions {
  readonly appApiBaseUrl: string;
  readonly appApiServiceToken: string;
  readonly limit?: number;
}

export interface EntitlementSyncResult {
  readonly syncedCount: number;
  readonly nextAfterSequence: number | null;
}

/**
 * Only feature keys with a numeric per-period limit map to a Foundry AI
 * operation quota. `receipt_forwarding`/`connected_mailbox_scan` and the
 * `ocr_mode_*` boolean gates are App API-only product flags -- see Phase
 * 0K Wave B plan "Scope decisions" #4.
 */
function featureKeyToOperation(featureKey: string): AiOperation | null {
  return featureKey === "ai_search" ? "AI_SEARCH" : null;
}

async function readCursor(database: Kysely<FoundryDatabase>): Promise<number> {
  const row = await database
    .selectFrom("foundry.service_metadata")
    .select("value")
    .where("key", "=", SYNC_CURSOR_KEY)
    .executeTakeFirst();
  if (!row) return 0;
  const value = row.value as { afterSequence?: number } | null;
  return typeof value?.afterSequence === "number" ? value.afterSequence : 0;
}

async function writeCursor(
  database: Kysely<FoundryDatabase>,
  afterSequence: number,
): Promise<void> {
  await database
    .insertInto("foundry.service_metadata")
    .values({ key: SYNC_CURSOR_KEY, value: { afterSequence } })
    .onConflict((conflict) =>
      conflict.column("key").doUpdateSet({
        value: { afterSequence },
        updated_at: new Date(),
      }),
    )
    .execute();
}

/**
 * Pulls new entitlement snapshots from App API's outbox
 * (GET /internal/v1/entitlement-snapshots) and mirrors any AI-operation
 * quota-relevant entitlement into `foundry.tenant_ai_quotas` (aggregate
 * scope only -- `ai_model_id IS NULL`). A disabled entitlement is synced
 * as a hard block (`max_jobs = 0`), not skipped, so reservations
 * correctly fail rather than finding no policy and proceeding
 * unchecked. Callable on demand (POST /internal/v1/entitlement-sync);
 * no background poller exists yet (Phase 0L has the scheduler).
 */
export async function syncEntitlementsFromOutbox(
  database: Kysely<FoundryDatabase>,
  options: EntitlementSyncOptions,
): Promise<EntitlementSyncResult> {
  const client = createAppApiClient(options.appApiBaseUrl);
  const afterSequence = await readCursor(database);
  const { data, error } = await client.GET("/internal/v1/entitlement-snapshots", {
    params: { query: { afterSequence, limit: options.limit ?? 100 } },
    headers: { Authorization: `Bearer ${options.appApiServiceToken}` },
  });
  if (error) {
    throw new Error(
      `Failed to fetch entitlement snapshots from App API: ${JSON.stringify(error)}`,
    );
  }

  let syncedCount = 0;
  for (const snapshot of data.items) {
    for (const entitlement of snapshot.entitlements) {
      const operation = featureKeyToOperation(entitlement.featureKey);
      if (!operation) continue;

      const periodType = entitlement.isEnabled ? entitlement.limitPeriod : "monthly";
      const maxJobs = entitlement.isEnabled ? entitlement.limitValue : 0;
      if (periodType === null) continue;

      await database
        .insertInto("foundry.tenant_ai_quotas")
        .values({
          id: randomUUID(),
          tenant_id: snapshot.tenantId,
          operation,
          ai_model_id: null,
          period_type: periodType,
          max_jobs: maxJobs,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["tenant_id", "operation"])
            .where("ai_model_id", "is", null)
            .doUpdateSet({
              period_type: periodType,
              max_jobs: maxJobs,
              updated_at: new Date(),
            }),
        )
        .execute();
      syncedCount += 1;
    }
  }

  await writeCursor(database, data.nextAfterSequence ?? afterSequence);
  return { syncedCount, nextAfterSequence: data.nextAfterSequence };
}
