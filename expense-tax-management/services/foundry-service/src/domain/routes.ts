import type { EffectiveRouteResponse } from "@expense-tax/contracts";
import type { Kysely } from "kysely";

import type { FoundryDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";

export interface ResolveEffectiveRouteInput {
  readonly operation: "RECEIPT_OCR" | "AI_SEARCH";
  readonly modeKey: string;
}

export interface RoutesDomain {
  resolveEffectiveRoute(
    input: ResolveEffectiveRouteInput,
  ): Promise<EffectiveRouteResponse>;
}

/**
 * Resolves a curated (operation, modeKey) pair to its currently pinned
 * immutable route version. Only active rows participate: a mode disabled
 * after job creation resolves to NOT_FOUND (the worker then fails the job
 * cleanly instead of running against a retired route). All misses return
 * the same NOT_FOUND — route/model existence is not an oracle.
 *
 * No secrets cross this boundary: provider kind + raw model ID are
 * execution parameters the worker needs, not credentials (those arrive
 * via Secret Manager route-scoped reads, future work).
 */
export function createRoutesDomain(database: Kysely<FoundryDatabase>): RoutesDomain {
  return {
    async resolveEffectiveRoute(input) {
      const mode = await database
        .selectFrom("foundry.ai_modes")
        .selectAll()
        .where("key", "=", input.modeKey)
        .where("operation", "=", input.operation)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!mode) throw DomainError.notFound();

      const route = await database
        .selectFrom("foundry.ai_mode_route_versions")
        .selectAll()
        .where("ai_mode_id", "=", mode.id)
        .where("is_current", "=", true)
        .executeTakeFirst();
      if (!route) throw DomainError.notFound();

      const model = await database
        .selectFrom("foundry.ai_models")
        .selectAll()
        .where("id", "=", route.ai_model_id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!model) throw DomainError.notFound();

      const connection = await database
        .selectFrom("foundry.provider_connections")
        .selectAll()
        .where("id", "=", model.provider_connection_id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!connection) throw DomainError.notFound();

      return {
        aiModeId: mode.id,
        routeVersionId: route.id,
        routeVersionNumber: route.version_number,
        aiModelId: model.id,
        providerKind: connection.provider_kind,
        providerModelId: model.provider_model_id,
      };
    },
  };
}
