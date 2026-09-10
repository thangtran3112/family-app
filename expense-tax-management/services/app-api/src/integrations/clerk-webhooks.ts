import { randomUUID } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";
import { ClerkWebhookPayloadError, parseClerkWebhookEvent, type ClerkWebhookEvent } from "./clerk-webhook-signature.js";

export interface ClerkWebhookMutation {
  upsertUser(input: { clerkUserId: string; email: string; displayName: string }): Promise<void>;
  markUserDeleted(clerkUserId: string): Promise<void>;
  upsertOrganization(input: { clerkOrgId: string; name: string }): Promise<void>;
  markOrganizationDeleted(clerkOrgId: string): Promise<void>;
  upsertMembership(input: { clerkUserId: string; clerkOrgId: string; role: "owner" | "admin" | "member" }): Promise<void>;
  markMembershipDeleted(clerkUserId: string, clerkOrgId: string): Promise<void>;
}

export interface ClerkWebhookRepository {
  processEvent(event: ClerkWebhookEvent, operation: (mutation: ClerkWebhookMutation) => Promise<void>): Promise<{ readonly replayed: boolean }>;
}

export interface ClerkWebhookHandler {
  handle(event: ClerkWebhookEvent): Promise<{ readonly replayed: boolean }>;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function requiredString(value: unknown, field: string): string {
  const result = stringValue(value, "");
  if (!result) throw new ClerkWebhookPayloadError(`Missing Clerk ${field}`);
  return result;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function userFields(data: Record<string, unknown>) {
  const addresses = Array.isArray(data.email_addresses) ? data.email_addresses : [];
  const primary = addresses.find((entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).id === data.primary_email_address_id);
  const email = primary && typeof primary === "object" ? (primary as Record<string, unknown>).email_address : undefined;
  const clerkUserId = requiredString(data.id, "user ID");
  const primaryEmail = stringValue(email, "").toLowerCase();
  if (!validEmail(primaryEmail)) throw new ClerkWebhookPayloadError("Missing or invalid primary Clerk email");
  return {
    clerkUserId,
    email: primaryEmail,
    displayName: [data.first_name, data.last_name].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ") || stringValue(data.username, "Clerk user"),
  };
}

function membershipFields(data: Record<string, unknown>) {
  const organization = data.organization;
  const publicUser = data.public_user_data;
  const clerkOrgId = typeof organization === "object" && organization !== null ? stringValue((organization as Record<string, unknown>).id, "") : stringValue(data.organization_id, "");
  const clerkUserId = typeof publicUser === "object" && publicUser !== null ? stringValue((publicUser as Record<string, unknown>).user_id, "") : stringValue(data.public_user_data_id, "");
  const role = data.role === "org:owner" ? "owner" : data.role === "org:admin" ? "admin" : data.role === "org:member" ? "member" : null;
  if (!clerkUserId || !clerkOrgId || role === null) throw new ClerkWebhookPayloadError("Malformed Clerk membership event");
  return { clerkUserId, clerkOrgId, role } as const;
}

async function dispatch(event: ClerkWebhookEvent, mutation: ClerkWebhookMutation): Promise<void> {
  switch (event.type) {
    case "user.created":
    case "user.updated": {
      const user = userFields(event.data);
      await mutation.upsertUser(user);
      return;
    }
    case "user.deleted":
      await mutation.markUserDeleted(requiredString(event.data.id, "user ID"));
      return;
    case "organization.created":
    case "organization.updated":
      await mutation.upsertOrganization({ clerkOrgId: requiredString(event.data.id, "organization ID"), name: requiredString(event.data.name, "organization name") });
      return;
    case "organization.deleted":
      await mutation.markOrganizationDeleted(requiredString(event.data.id, "organization ID"));
      return;
    case "organizationMembership.created":
    case "organizationMembership.updated": {
      const membership = membershipFields(event.data);
      await mutation.upsertMembership(membership);
      return;
    }
    case "organizationMembership.deleted": {
      const membership = membershipFields(event.data);
      await mutation.markMembershipDeleted(membership.clerkUserId, membership.clerkOrgId);
      return;
    }
  }
}

export function createClerkWebhookHandler(repository: ClerkWebhookRepository): ClerkWebhookHandler {
  return { handle: (event) => repository.processEvent(event, (mutation) => dispatch(event, mutation)) };
}

function slugFor(name: string, clerkOrgId: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "organization";
  return `${slug}-${clerkOrgId.replace(/[^a-zA-Z0-9]/g, "").slice(-16).toLowerCase()}`;
}

function databaseMutation(transaction: Transaction<AppDatabase>): ClerkWebhookMutation {
  return {
    async upsertUser(input) {
      const now = new Date();
      const existing = await transaction.selectFrom("app.users").select("id").where("clerk_user_id", "=", input.clerkUserId).executeTakeFirst();
      if (existing) {
        await transaction.updateTable("app.users").set({ primary_email: input.email, display_name: input.displayName.slice(0, 100), status: "active", updated_at: now }).where("id", "=", existing.id).execute();
      } else {
        await transaction.insertInto("app.users").values({ id: randomUUID(), clerk_user_id: input.clerkUserId, primary_email: input.email, display_name: input.displayName.slice(0, 100), status: "active", created_at: now, updated_at: now }).execute();
      }
    },
    async markUserDeleted(clerkUserId) {
      const now = new Date();
      await transaction.updateTable("app.users").set({ status: "disabled", updated_at: now }).where("clerk_user_id", "=", clerkUserId).execute();
      await transaction.updateTable("app.tenant_memberships").set({ status: "inactive", updated_at: now }).where("user_id", "in", transaction.selectFrom("app.users").select("id").where("clerk_user_id", "=", clerkUserId)).execute();
    },
    async upsertOrganization(input) {
      const now = new Date();
      const name = input.name.slice(0, 100);
      const existing = await transaction.selectFrom("app.tenants").select("id").where("clerk_org_id", "=", input.clerkOrgId).executeTakeFirst();
      if (existing) {
        await transaction.updateTable("app.tenants").set({ name, status: "active", archived_at: null, updated_at: now }).where("id", "=", existing.id).execute();
      } else {
        await transaction.insertInto("app.tenants").values({ id: randomUUID(), clerk_org_id: input.clerkOrgId, name, slug: slugFor(name, input.clerkOrgId), status: "active", version: 1, created_at: now, updated_at: now, archived_at: null }).execute();
      }
    },
    async markOrganizationDeleted(clerkOrgId) {
      const now = new Date();
      await transaction.updateTable("app.tenants").set({ status: "archived", archived_at: now, updated_at: now }).where("clerk_org_id", "=", clerkOrgId).execute();
      await transaction.updateTable("app.tenant_memberships").set({ status: "inactive", updated_at: now }).where("tenant_id", "in", transaction.selectFrom("app.tenants").select("id").where("clerk_org_id", "=", clerkOrgId)).execute();
    },
    async upsertMembership(input) {
      const user = await transaction.selectFrom("app.users").select("id").where("clerk_user_id", "=", input.clerkUserId).executeTakeFirst();
      const tenant = await transaction.selectFrom("app.tenants").select("id").where("clerk_org_id", "=", input.clerkOrgId).executeTakeFirst();
      if (!user || !tenant) throw new Error("Clerk membership mapping missing");
      await transaction.insertInto("app.tenant_memberships").values({ tenant_id: tenant.id, user_id: user.id, role: input.role, status: "active", version: 1, created_at: new Date(), updated_at: new Date() }).onConflict((conflict) => conflict.columns(["tenant_id", "user_id"]).doUpdateSet({ role: input.role, status: "active", updated_at: new Date() })).execute();
    },
    async markMembershipDeleted(clerkUserId, clerkOrgId) {
      const user = await transaction.selectFrom("app.users").select("id").where("clerk_user_id", "=", clerkUserId).executeTakeFirst();
      const tenant = await transaction.selectFrom("app.tenants").select("id").where("clerk_org_id", "=", clerkOrgId).executeTakeFirst();
      if (!user || !tenant) throw new Error("Clerk membership mapping missing");
      await transaction.updateTable("app.tenant_memberships").set({ status: "inactive", updated_at: new Date() }).where("user_id", "=", user.id).where("tenant_id", "=", tenant.id).execute();
    },
  };
}

export function createDatabaseClerkWebhookRepository(database: Kysely<AppDatabase>): ClerkWebhookRepository {
  return {
    async processEvent(event, operation) {
      return database.transaction().execute(async (transaction) => {
        const inserted = await transaction.insertInto("app.clerk_webhook_events").values({ id: randomUUID(), event_id: event.id, event_type: event.type, processed_at: new Date(), created_at: new Date() }).onConflict((conflict) => conflict.column("event_id").doNothing()).returning("event_id").executeTakeFirst();
        if (!inserted) return { replayed: true };
        await operation(databaseMutation(transaction));
        return { replayed: false };
      });
    },
  };
}

export function parseClerkEventFromBody(id: string, body: unknown): ClerkWebhookEvent {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ClerkWebhookPayloadError("Malformed Clerk webhook payload");
  const record = body as Record<string, unknown>;
  return parseClerkWebhookEvent(id, stringValue(record.type, ""), record.data);
}
