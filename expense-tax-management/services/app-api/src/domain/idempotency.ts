import { createHash, randomUUID } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import type { AppDatabase, JsonValue } from "../database/types.js";
import { DomainError } from "../errors.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

export interface MutationResult<
  T,
  Status extends 200 | 201 = 200 | 201,
> {
  readonly statusCode: Status;
  readonly body: T;
  readonly replayed: boolean;
}

export interface IdempotentMutationInput<T, Status extends 200 | 201> {
  readonly actorKey: string;
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly statusCode: Status;
  readonly parseBody: (value: unknown) => T;
  readonly execute: (transaction: Transaction<AppDatabase>) => Promise<T>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function hashNormalizedRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isIdempotencyUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const databaseError = error as { code?: unknown; constraint?: unknown };
  return (
    databaseError.code === "23505" &&
    databaseError.constraint ===
      "idempotency_records_actor_operation_key_unique"
  );
}

function replay<T, Status extends 200 | 201>(
  requestHash: string,
  stored: { readonly request_hash: string; readonly response_body: JsonValue; readonly response_status: number },
  parseBody: (value: unknown) => T,
): MutationResult<T, Status> {
  if (stored.request_hash !== requestHash) throw DomainError.conflict();
  if (stored.response_status !== 200 && stored.response_status !== 201) {
    throw new Error("Invalid stored idempotency response status");
  }
  return {
    statusCode: stored.response_status as Status,
    body: parseBody(stored.response_body),
    replayed: true,
  };
}

export async function executeIdempotentMutation<T, Status extends 200 | 201>(
  database: Kysely<AppDatabase>,
  input: IdempotentMutationInput<T, Status>,
): Promise<MutationResult<T, Status>> {
  try {
    return await database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("app.idempotency_records")
        .select(["id", "request_hash", "response_body", "response_status", "expires_at"])
        .where("actor_key", "=", input.actorKey)
        .where("operation_key", "=", input.operationKey)
        .where("idempotency_key", "=", input.idempotencyKey)
        .forUpdate()
        .executeTakeFirst();

      if (existing && existing.expires_at > new Date()) {
        return replay(input.requestHash, existing, input.parseBody);
      }
      if (existing) {
        await transaction
          .deleteFrom("app.idempotency_records")
          .where("id", "=", existing.id)
          .execute();
      }

      const body = await input.execute(transaction);
      await transaction
        .insertInto("app.idempotency_records")
        .values({
          id: randomUUID(),
          actor_key: input.actorKey,
          operation_key: input.operationKey,
          idempotency_key: input.idempotencyKey,
          request_hash: input.requestHash,
          response_status: input.statusCode,
          response_body: toJsonValue(body),
          resource_type: null,
          resource_id: null,
          expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        })
        .execute();

      return { statusCode: input.statusCode, body, replayed: false };
    });
  } catch (error: unknown) {
    if (!isIdempotencyUniqueViolation(error)) throw error;

    const stored = await database
      .selectFrom("app.idempotency_records")
      .select(["request_hash", "response_body", "response_status"])
      .where("actor_key", "=", input.actorKey)
      .where("operation_key", "=", input.operationKey)
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirstOrThrow();
    return replay(input.requestHash, stored, input.parseBody);
  }
}
