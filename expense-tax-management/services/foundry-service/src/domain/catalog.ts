import { randomUUID } from "node:crypto";

import type {
  AiMode,
  AiModeCreateRequest,
  AiModel,
  AiModelCreateRequest,
  AiModeRouteVersion,
  AiModeRouteVersionCreateRequest,
  ProviderConnection,
  ProviderConnectionCreateRequest,
  ProviderConnectionUpdateRequest,
} from "@expense-tax/contracts";
import type { Kysely, Selectable } from "kysely";

import type { FoundryDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import type { SecretStore } from "./secrets.js";

interface ActorContext {
  readonly actorPlatformSubject: string;
  readonly requestId: string;
}

export interface CatalogDomain {
  createProviderConnection(
    input: ActorContext & { readonly request: ProviderConnectionCreateRequest },
  ): Promise<ProviderConnection>;
  updateProviderConnection(
    input: ActorContext & {
      readonly id: string;
      readonly request: ProviderConnectionUpdateRequest;
    },
  ): Promise<ProviderConnection>;
  listProviderConnections(): Promise<readonly ProviderConnection[]>;
  createAiModel(
    input: ActorContext & { readonly request: AiModelCreateRequest },
  ): Promise<AiModel>;
  listAiModels(): Promise<readonly AiModel[]>;
  createAiMode(
    input: ActorContext & { readonly request: AiModeCreateRequest },
  ): Promise<AiMode>;
  listAiModes(): Promise<readonly AiMode[]>;
  createRouteVersion(
    input: ActorContext & {
      readonly aiModeId: string;
      readonly request: AiModeRouteVersionCreateRequest;
    },
  ): Promise<AiModeRouteVersion>;
}

function toProviderConnection(
  row: Selectable<FoundryDatabase["foundry.provider_connections"]>,
): ProviderConnection {
  return {
    id: row.id,
    key: row.key,
    providerKind: row.provider_kind,
    displayName: row.display_name,
    secretReference: row.secret_reference,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toAiModel(row: Selectable<FoundryDatabase["foundry.ai_models"]>): AiModel {
  return {
    id: row.id,
    providerConnectionId: row.provider_connection_id,
    providerModelId: row.provider_model_id,
    meteredModelKey: row.metered_model_key,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function toAiMode(row: Selectable<FoundryDatabase["foundry.ai_modes"]>): AiMode {
  return {
    id: row.id,
    key: row.key,
    displayName: row.display_name,
    description: row.description,
    operation: row.operation,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function toRouteVersion(
  row: Selectable<FoundryDatabase["foundry.ai_mode_route_versions"]>,
): AiModeRouteVersion {
  return {
    id: row.id,
    aiModeId: row.ai_mode_id,
    versionNumber: row.version_number,
    aiModelId: row.ai_model_id,
    isCurrent: row.is_current,
    createdAt: row.created_at.toISOString(),
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

export function createCatalogDomain(
  database: Kysely<FoundryDatabase>,
  secretStore: SecretStore,
): CatalogDomain {
  return {
    async createProviderConnection(input) {
      return runInsert(() =>
        database.transaction().execute(async (transaction) => {
          const secretReference = await secretStore.store(
            input.request.secretValue,
          );
          const now = new Date();
          const created = await transaction
            .insertInto("foundry.provider_connections")
            .values({
              id: randomUUID(),
              key: input.request.key,
              provider_kind: input.request.providerKind,
              display_name: input.request.displayName,
              secret_reference: secretReference,
              created_at: now,
              updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAuditEvent(transaction, {
            actorPlatformSubject: input.actorPlatformSubject,
            action: "provider_connection.created",
            outcome: "success",
            resourceType: "provider_connection",
            resourceId: created.id,
            requestId: input.requestId,
          });
          return toProviderConnection(created);
        }),
      );
    },
    async updateProviderConnection(input) {
      return runInsert(() =>
        database.transaction().execute(async (transaction) => {
          let secretReference: string | undefined;
          if (input.request.secretValue !== undefined) {
            secretReference = await secretStore.store(input.request.secretValue);
          }
          const updated = await transaction
            .updateTable("foundry.provider_connections")
            .set({
              ...(input.request.displayName === undefined
                ? {}
                : { display_name: input.request.displayName }),
              ...(input.request.status === undefined
                ? {}
                : { status: input.request.status }),
              ...(secretReference === undefined
                ? {}
                : { secret_reference: secretReference }),
              updated_at: new Date(),
            })
            .where("id", "=", input.id)
            .returningAll()
            .executeTakeFirst();
          if (!updated) throw DomainError.notFound();
          await recordAuditEvent(transaction, {
            actorPlatformSubject: input.actorPlatformSubject,
            action: "provider_connection.updated",
            outcome: "success",
            resourceType: "provider_connection",
            resourceId: updated.id,
            requestId: input.requestId,
          });
          return toProviderConnection(updated);
        }),
      );
    },
    async listProviderConnections() {
      const rows = await database
        .selectFrom("foundry.provider_connections")
        .selectAll()
        .execute();
      return rows.map(toProviderConnection);
    },
    async createAiModel(input) {
      return runInsert(() =>
        database.transaction().execute(async (transaction) => {
          const created = await transaction
            .insertInto("foundry.ai_models")
            .values({
              id: randomUUID(),
              provider_connection_id: input.request.providerConnectionId,
              provider_model_id: input.request.providerModelId,
              metered_model_key: input.request.meteredModelKey,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAuditEvent(transaction, {
            actorPlatformSubject: input.actorPlatformSubject,
            action: "ai_model.created",
            outcome: "success",
            resourceType: "ai_model",
            resourceId: created.id,
            requestId: input.requestId,
          });
          return toAiModel(created);
        }),
      );
    },
    async listAiModels() {
      const rows = await database.selectFrom("foundry.ai_models").selectAll().execute();
      return rows.map(toAiModel);
    },
    async createAiMode(input) {
      return runInsert(() =>
        database.transaction().execute(async (transaction) => {
          const created = await transaction
            .insertInto("foundry.ai_modes")
            .values({
              id: randomUUID(),
              key: input.request.key,
              display_name: input.request.displayName,
              description: input.request.description ?? null,
              operation: input.request.operation,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAuditEvent(transaction, {
            actorPlatformSubject: input.actorPlatformSubject,
            action: "ai_mode.created",
            outcome: "success",
            resourceType: "ai_mode",
            resourceId: created.id,
            requestId: input.requestId,
          });
          return toAiMode(created);
        }),
      );
    },
    async listAiModes() {
      const rows = await database.selectFrom("foundry.ai_modes").selectAll().execute();
      return rows.map(toAiMode);
    },
    async createRouteVersion(input) {
      const mode = await database
        .selectFrom("foundry.ai_modes")
        .select("id")
        .where("id", "=", input.aiModeId)
        .executeTakeFirst();
      if (!mode) throw DomainError.notFound();

      return runInsert(() =>
        database.transaction().execute(async (transaction) => {
          const latest = await transaction
            .selectFrom("foundry.ai_mode_route_versions")
            .select(({ fn }) => fn.max("version_number").as("max_version"))
            .where("ai_mode_id", "=", input.aiModeId)
            .executeTakeFirst();
          const nextVersionNumber = (latest?.max_version ?? 0) + 1;

          await transaction
            .updateTable("foundry.ai_mode_route_versions")
            .set({ is_current: false })
            .where("ai_mode_id", "=", input.aiModeId)
            .where("is_current", "=", true)
            .execute();

          const created = await transaction
            .insertInto("foundry.ai_mode_route_versions")
            .values({
              id: randomUUID(),
              ai_mode_id: input.aiModeId,
              version_number: nextVersionNumber,
              ai_model_id: input.request.aiModelId,
              is_current: true,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAuditEvent(transaction, {
            actorPlatformSubject: input.actorPlatformSubject,
            action: "ai_mode_route_version.created",
            outcome: "success",
            resourceType: "ai_mode_route_version",
            resourceId: created.id,
            requestId: input.requestId,
          });
          return toRouteVersion(created);
        }),
      );
    },
  };
}
