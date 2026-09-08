import { randomUUID } from "node:crypto";

import type {
  IdentityProvisioningRequest,
  User,
} from "@expense-tax/contracts";
import type { Kysely, Selectable, Transaction } from "kysely";

import type { AppDatabase, UserTable } from "../database/types.js";
import type {
  AuthenticatedUserContext,
  IdentityResolver,
} from "./authenticated-user.js";
import { recordAuditEvent } from "./audit.js";

export interface ProvisionIdentityInput {
  readonly identity: IdentityProvisioningRequest;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

export interface IdentityDomain extends IdentityResolver {
  provision(input: ProvisionIdentityInput): Promise<{
    readonly user: User;
    readonly created: boolean;
  }>;
}

function toIsoTimestamp(value: Date): string {
  return value.toISOString();
}

function toUser(row: Selectable<UserTable>): User {
  return {
    id: row.id,
    primaryEmail: row.primary_email,
    displayName: row.display_name,
    status: row.status,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

async function updateExistingIdentity(
  transaction: Transaction<AppDatabase>,
  identityId: string,
  userId: string,
  input: ProvisionIdentityInput,
): Promise<{ readonly user: User; readonly created: false }> {
  const now = new Date();
  await transaction
    .updateTable("app.auth_identities")
    .set({
      verified_email: input.identity.email,
      email_verified: true,
      last_authenticated_at: now,
      updated_at: now,
    })
    .where("id", "=", identityId)
    .execute();
  const user = await transaction
    .updateTable("app.users")
    .set({
      primary_email: input.identity.email,
      display_name: input.identity.displayName,
      updated_at: now,
    })
    .where("id", "=", userId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordAuditEvent(transaction, {
    actorServicePrincipal: input.actorServicePrincipal,
    action: "identity.refreshed",
    outcome: "success",
    resourceType: "user",
    resourceId: userId,
    requestId: input.requestId,
  });

  return { user: toUser(user), created: false };
}

async function findIdentity(
  transaction: Transaction<AppDatabase>,
  identity: IdentityProvisioningRequest,
): Promise<{ readonly id: string; readonly user_id: string } | undefined> {
  return transaction
    .selectFrom("app.auth_identities")
    .select(["id", "user_id"])
    .where("issuer", "=", identity.issuer)
    .where("subject", "=", identity.subject)
    .executeTakeFirst();
}

function isIdentityUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const databaseError = error as { code?: unknown; constraint?: unknown };
  return (
    databaseError.code === "23505" &&
    databaseError.constraint === "auth_identities_issuer_subject_unique"
  );
}

export function createIdentityDomain(
  database: Kysely<AppDatabase>,
): IdentityDomain {
  return {
    async provision(input) {
      try {
        return await database.transaction().execute(async (transaction) => {
          const existing = await findIdentity(transaction, input.identity);
          if (existing) {
            return updateExistingIdentity(
              transaction,
              existing.id,
              existing.user_id,
              input,
            );
          }

          const now = new Date();
          const userId = randomUUID();
          const user = await transaction
            .insertInto("app.users")
            .values({
              id: userId,
              primary_email: input.identity.email,
              display_name: input.identity.displayName,
              status: "active",
              created_at: now,
              updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("app.auth_identities")
            .values({
              id: randomUUID(),
              user_id: userId,
              issuer: input.identity.issuer,
              subject: input.identity.subject,
              verified_email: input.identity.email,
              email_verified: true,
              last_authenticated_at: now,
              created_at: now,
              updated_at: now,
            })
            .execute();
          await recordAuditEvent(transaction, {
            actorServicePrincipal: input.actorServicePrincipal,
            action: "identity.provisioned",
            outcome: "success",
            resourceType: "user",
            resourceId: userId,
            requestId: input.requestId,
          });

          return { user: toUser(user), created: true as const };
        });
      } catch (error: unknown) {
        if (!isIdentityUniqueViolation(error)) throw error;

        return database.transaction().execute(async (transaction) => {
          const existing = await findIdentity(transaction, input.identity);
          if (!existing) throw error;
          return updateExistingIdentity(
            transaction,
            existing.id,
            existing.user_id,
            input,
          );
        });
      }
    },

    async resolve(issuer, subject): Promise<AuthenticatedUserContext | null> {
      const user = await database
        .selectFrom("app.auth_identities as identity")
        .innerJoin("app.users as user", "user.id", "identity.user_id")
        .select([
          "user.id",
          "user.primary_email",
          "user.display_name",
          "user.status",
        ])
        .where("identity.issuer", "=", issuer)
        .where("identity.subject", "=", subject)
        .executeTakeFirst();

      return user
        ? {
            id: user.id,
            primaryEmail: user.primary_email,
            displayName: user.display_name,
            status: user.status,
          }
        : null;
    },
  };
}
