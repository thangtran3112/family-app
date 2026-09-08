import { randomUUID } from "node:crypto";

import {
  EntitlementSnapshotSchema,
  type ActivePlan,
  type EffectiveEntitlement,
  type EntitlementSnapshot,
  type FeatureDefinition,
  type FeatureDefinitionCreateRequest,
  type FeatureKey,
  type Plan,
  type PlanCreateRequest,
  type PlanVersion,
  type PlanVersionCreateRequest,
  type PlanWithVersions,
  type TenantAddon,
  type TenantAddonCreateRequest,
  type TenantSubscription,
  type TenantSubscriptionUpdateRequest,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";

const TRIAL_PLAN_KEY = "trial";

export interface PlansDomain {
  createPlan(input: {
    readonly request: PlanCreateRequest;
    readonly actorServicePrincipal: string;
    readonly requestId: string;
  }): Promise<Plan>;
  createPlanVersion(input: {
    readonly planId: string;
    readonly request: PlanVersionCreateRequest;
    readonly actorServicePrincipal: string;
    readonly requestId: string;
  }): Promise<PlanVersion>;
  createFeatureDefinition(input: {
    readonly request: FeatureDefinitionCreateRequest;
    readonly actorServicePrincipal: string;
    readonly requestId: string;
  }): Promise<FeatureDefinition>;
  listPlansAdmin(): Promise<readonly PlanWithVersions[]>;
  listActivePlans(): Promise<readonly ActivePlan[]>;
  getSubscription(input: { readonly tenantId: string }): Promise<TenantSubscription>;
  updateSubscription(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly request: TenantSubscriptionUpdateRequest;
    readonly requestId: string;
  }): Promise<TenantSubscription>;
  addAddon(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly request: TenantAddonCreateRequest;
    readonly requestId: string;
  }): Promise<TenantAddon>;
  removeAddon(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly featureKey: FeatureKey;
    readonly requestId: string;
  }): Promise<void>;
  resolveEffectiveEntitlements(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
  }): Promise<readonly EffectiveEntitlement[]>;
  listEntitlementSnapshotsAfter(input: {
    readonly afterSequence: number;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly EntitlementSnapshot[];
    readonly nextAfterSequence: number | null;
  }>;
}

function toPlan(row: Selectable<AppDatabase["app.plans"]>): Plan {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toEntitlement(row: {
  feature_key: string;
  is_enabled: boolean;
  limit_value: number | null;
  limit_period: "monthly" | "unlimited" | null;
}) {
  return {
    featureKey: row.feature_key as FeatureKey,
    isEnabled: row.is_enabled,
    limitValue: row.limit_value,
    limitPeriod: row.limit_period,
  };
}

async function versionEntitlements(
  database: Kysely<AppDatabase>,
  planVersionId: string,
) {
  const rows = await database
    .selectFrom("app.plan_entitlements as entitlement")
    .innerJoin(
      "app.feature_definitions as feature",
      "feature.id",
      "entitlement.feature_definition_id",
    )
    .select([
      "feature.key as feature_key",
      "entitlement.is_enabled",
      "entitlement.limit_value",
      "entitlement.limit_period",
    ])
    .where("entitlement.plan_version_id", "=", planVersionId)
    .execute();
  return rows.map(toEntitlement);
}

function toVersion(
  row: Selectable<AppDatabase["app.plan_versions"]>,
  entitlements: ReturnType<typeof toEntitlement>[],
): PlanVersion {
  return {
    id: row.id,
    planId: row.plan_id,
    versionNumber: row.version_number,
    effectiveAt: row.effective_at.toISOString(),
    isCurrent: row.is_current,
    entitlements,
    createdAt: row.created_at.toISOString(),
  };
}

function toFeatureDefinition(
  row: Selectable<AppDatabase["app.feature_definitions"]>,
): FeatureDefinition {
  return {
    id: row.id,
    key: row.key as FeatureKey,
    name: row.name,
    description: row.description,
    createdAt: row.created_at.toISOString(),
  };
}

async function requireTenantOwner(
  database: Kysely<AppDatabase>,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const membership = await database
    .selectFrom("app.tenant_memberships")
    .select("role")
    .where("tenant_id", "=", tenantId)
    .where("user_id", "=", actorUserId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!membership) throw DomainError.notFound();
  if (membership.role !== "owner") throw DomainError.forbidden();
}

async function requireActiveTenantMember(
  database: Kysely<AppDatabase>,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const membership = await database
    .selectFrom("app.tenant_memberships")
    .select("role")
    .where("tenant_id", "=", tenantId)
    .where("user_id", "=", actorUserId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!membership) throw DomainError.notFound();
}

/**
 * Every tenant is entitled to the trial plan the moment it's referenced,
 * without requiring Wave 1's tenant-creation flow to know about billing
 * (Implementation Decision #2 in the Phase 0J1 plan). Idempotent under
 * concurrent callers via ON CONFLICT DO NOTHING + re-select.
 */
async function ensureSubscription(
  database: Kysely<AppDatabase>,
  tenantId: string,
): Promise<Selectable<AppDatabase["app.tenant_subscriptions"]>> {
  const existing = await database
    .selectFrom("app.tenant_subscriptions")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .executeTakeFirst();
  if (existing) return existing;

  const trialVersion = await database
    .selectFrom("app.plan_versions as version")
    .innerJoin("app.plans as plan", "plan.id", "version.plan_id")
    .select("version.id")
    .where("plan.key", "=", TRIAL_PLAN_KEY)
    .where("version.is_current", "=", true)
    .executeTakeFirst();
  if (!trialVersion) throw DomainError.validation();

  await database
    .insertInto("app.tenant_subscriptions")
    .values({
      tenant_id: tenantId,
      plan_version_id: trialVersion.id,
      status: "trialing",
    })
    .onConflict((conflict) => conflict.column("tenant_id").doNothing())
    .execute();

  return await database
    .selectFrom("app.tenant_subscriptions")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .executeTakeFirstOrThrow();
}

async function toSubscription(
  database: Kysely<AppDatabase>,
  row: Selectable<AppDatabase["app.tenant_subscriptions"]>,
): Promise<TenantSubscription> {
  const plan = await database
    .selectFrom("app.plan_versions as version")
    .innerJoin("app.plans as plan", "plan.id", "version.plan_id")
    .select("plan.key")
    .where("version.id", "=", row.plan_version_id)
    .executeTakeFirstOrThrow();
  return {
    tenantId: row.tenant_id,
    planKey: plan.key,
    planVersionId: row.plan_version_id,
    status: row.status,
    currentEntitlementVersion: row.current_entitlement_version,
    startedAt: row.started_at.toISOString(),
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function resolveWithinTransaction(
  transaction: Transaction<AppDatabase>,
  tenantId: string,
): Promise<readonly EffectiveEntitlement[]> {
  const subscription = await ensureSubscription(transaction, tenantId);
  const planEntitlements = await versionEntitlements(
    transaction,
    subscription.plan_version_id,
  );
  const addons = await transaction
    .selectFrom("app.tenant_addons as addon")
    .innerJoin(
      "app.feature_definitions as feature",
      "feature.id",
      "addon.feature_definition_id",
    )
    .select(["feature.key as feature_key"])
    .where("addon.tenant_id", "=", tenantId)
    .where("addon.enabled", "=", true)
    .where((eb) =>
      eb.or([eb("addon.expires_at", "is", null), eb("addon.expires_at", ">", new Date())]),
    )
    .execute();
  const overrides = await transaction
    .selectFrom("app.tenant_feature_overrides as override")
    .innerJoin(
      "app.feature_definitions as feature",
      "feature.id",
      "override.feature_definition_id",
    )
    .select(["feature.key as feature_key", "override.override_enabled"])
    .where("override.tenant_id", "=", tenantId)
    .where((eb) =>
      eb.or([
        eb("override.expires_at", "is", null),
        eb("override.expires_at", ">", new Date()),
      ]),
    )
    .execute();

  const byKey = new Map<string, EffectiveEntitlement>();
  for (const entitlement of planEntitlements) {
    byKey.set(entitlement.featureKey, { ...entitlement, source: "plan" });
  }
  for (const addon of addons) {
    const existing = byKey.get(addon.feature_key);
    byKey.set(addon.feature_key, {
      featureKey: addon.feature_key as FeatureKey,
      limitValue: existing?.limitValue ?? null,
      limitPeriod: existing?.limitPeriod ?? null,
      isEnabled: true,
      source: "addon",
    });
  }
  for (const override of overrides) {
    const existing = byKey.get(override.feature_key);
    byKey.set(override.feature_key, {
      featureKey: override.feature_key as FeatureKey,
      limitValue: existing?.limitValue ?? null,
      limitPeriod: existing?.limitPeriod ?? null,
      isEnabled: override.override_enabled,
      source: "override",
    });
  }
  return [...byKey.values()];
}

/**
 * Bumps the tenant's monotonic entitlement version and writes one outbox
 * row with the freshly resolved snapshot, inside the caller's transaction.
 * Every mutation that can change effective entitlements (subscription
 * change, addon add/remove) must call this before committing.
 */
async function bumpEntitlementVersionAndPublish(
  transaction: Transaction<AppDatabase>,
  tenantId: string,
): Promise<number> {
  const updated = await transaction
    .updateTable("app.tenant_subscriptions")
    .set({
      current_entitlement_version: sql<number>`current_entitlement_version + 1`,
      updated_at: new Date(),
    })
    .where("tenant_id", "=", tenantId)
    .returning("current_entitlement_version")
    .executeTakeFirstOrThrow();
  const entitlements = await resolveWithinTransaction(transaction, tenantId);
  await transaction
    .insertInto("app.entitlement_snapshot_outbox")
    .values({
      tenant_id: tenantId,
      entitlement_version: updated.current_entitlement_version,
      payload: {
        tenantId,
        entitlementVersion: updated.current_entitlement_version,
        entitlements: entitlements.map((entitlement) => ({ ...entitlement })),
      },
    })
    .execute();
  return updated.current_entitlement_version;
}

export function createPlansDomain(database: Kysely<AppDatabase>): PlansDomain {
  return {
    async createPlan(input) {
      const now = new Date();
      try {
        const created = await database
          .insertInto("app.plans")
          .values({
            id: randomUUID(),
            key: input.request.key,
            name: input.request.name,
            description: input.request.description ?? null,
            created_at: now,
            updated_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toPlan(created);
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: string }).code === "23505"
        ) {
          throw DomainError.conflict();
        }
        throw error;
      }
    },
    async createPlanVersion(input) {
      const plan = await database
        .selectFrom("app.plans")
        .select("id")
        .where("id", "=", input.planId)
        .executeTakeFirst();
      if (!plan) throw DomainError.notFound();

      const featureDefinitions = await database
        .selectFrom("app.feature_definitions")
        .select(["id", "key"])
        .execute();
      const featureIdByKey = new Map(
        featureDefinitions.map((row) => [row.key, row.id]),
      );
      for (const entitlement of input.request.entitlements) {
        if (!featureIdByKey.has(entitlement.featureKey)) {
          throw DomainError.validation();
        }
      }

      try {
        return await database.transaction().execute(async (transaction) => {
          const latest = await transaction
            .selectFrom("app.plan_versions")
            .select(({ fn }) => fn.max("version_number").as("max_version"))
            .where("plan_id", "=", input.planId)
            .executeTakeFirst();
          const nextVersionNumber = (latest?.max_version ?? 0) + 1;

          await transaction
            .updateTable("app.plan_versions")
            .set({ is_current: false })
            .where("plan_id", "=", input.planId)
            .where("is_current", "=", true)
            .execute();

          const versionId = randomUUID();
          const versionRow = await transaction
            .insertInto("app.plan_versions")
            .values({
              id: versionId,
              plan_id: input.planId,
              version_number: nextVersionNumber,
              is_current: true,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          await transaction
            .insertInto("app.plan_entitlements")
            .values(
              input.request.entitlements.map((entitlement) => ({
                plan_version_id: versionId,
                feature_definition_id: featureIdByKey.get(entitlement.featureKey)!,
                is_enabled: entitlement.isEnabled,
                limit_value: entitlement.limitValue,
                limit_period: entitlement.limitPeriod,
              })),
            )
            .execute();

          await recordAuditEvent(transaction, {
            actorServicePrincipal: input.actorServicePrincipal,
            action: "plan_version.created",
            outcome: "success",
            resourceType: "plan_version",
            resourceId: versionId,
            requestId: input.requestId,
          });

          const entitlements = await versionEntitlements(transaction, versionId);
          return toVersion(versionRow, entitlements);
        });
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: string }).code === "23505"
        ) {
          throw DomainError.conflict();
        }
        throw error;
      }
    },
    async createFeatureDefinition(input) {
      try {
        const created = await database
          .insertInto("app.feature_definitions")
          .values({
            id: randomUUID(),
            key: input.request.key,
            name: input.request.name,
            description: input.request.description ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toFeatureDefinition(created);
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: string }).code === "23505"
        ) {
          throw DomainError.conflict();
        }
        throw error;
      }
    },
    async listPlansAdmin() {
      const plans = await database.selectFrom("app.plans").selectAll().execute();
      const result: PlanWithVersions[] = [];
      for (const plan of plans) {
        const versions = await database
          .selectFrom("app.plan_versions")
          .selectAll()
          .where("plan_id", "=", plan.id)
          .orderBy("version_number", "desc")
          .execute();
        const versionsWithEntitlements: PlanVersion[] = [];
        for (const version of versions) {
          const entitlements = await versionEntitlements(database, version.id);
          versionsWithEntitlements.push(toVersion(version, entitlements));
        }
        result.push({ ...toPlan(plan), versions: versionsWithEntitlements });
      }
      return result;
    },
    async listActivePlans() {
      const plans = await database
        .selectFrom("app.plans")
        .selectAll()
        .where("is_active", "=", true)
        .execute();
      const result: ActivePlan[] = [];
      for (const plan of plans) {
        const currentVersion = await database
          .selectFrom("app.plan_versions")
          .selectAll()
          .where("plan_id", "=", plan.id)
          .where("is_current", "=", true)
          .executeTakeFirst();
        if (!currentVersion) continue;
        const entitlements = await versionEntitlements(database, currentVersion.id);
        result.push({
          id: plan.id,
          key: plan.key,
          name: plan.name,
          description: plan.description,
          currentVersion: toVersion(currentVersion, entitlements),
        });
      }
      return result;
    },
    async getSubscription(input) {
      const subscription = await ensureSubscription(database, input.tenantId);
      return toSubscription(database, subscription);
    },
    async updateSubscription(input) {
      await requireTenantOwner(database, input.tenantId, input.actorUserId);
      const targetVersion = await database
        .selectFrom("app.plan_versions as version")
        .innerJoin("app.plans as plan", "plan.id", "version.plan_id")
        .select("version.id")
        .where("plan.key", "=", input.request.planKey)
        .where("version.is_current", "=", true)
        .executeTakeFirst();
      if (!targetVersion) throw DomainError.validation();

      await ensureSubscription(database, input.tenantId);
      return database.transaction().execute(async (transaction) => {
        const updated = await transaction
          .updateTable("app.tenant_subscriptions")
          .set({
            plan_version_id: targetVersion.id,
            status: "active",
            version: sql<number>`version + 1`,
            updated_at: new Date(),
          })
          .where("tenant_id", "=", input.tenantId)
          .returningAll()
          .executeTakeFirstOrThrow();
        await bumpEntitlementVersionAndPublish(transaction, input.tenantId);
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "subscription.updated",
          outcome: "success",
          resourceType: "tenant_subscription",
          resourceId: input.tenantId,
          requestId: input.requestId,
        });
        return toSubscription(transaction, updated);
      });
    },
    async addAddon(input) {
      await requireTenantOwner(database, input.tenantId, input.actorUserId);
      const feature = await database
        .selectFrom("app.feature_definitions")
        .select("id")
        .where("key", "=", input.request.featureKey)
        .executeTakeFirst();
      if (!feature) throw DomainError.validation();
      await ensureSubscription(database, input.tenantId);

      return database.transaction().execute(async (transaction) => {
        const now = new Date();
        const addon = await transaction
          .insertInto("app.tenant_addons")
          .values({
            id: randomUUID(),
            tenant_id: input.tenantId,
            feature_definition_id: feature.id,
            enabled: true,
            granted_by: input.actorUserId,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "feature_definition_id"]).doUpdateSet({
              enabled: true,
              granted_by: input.actorUserId,
              expires_at: null,
              updated_at: now,
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        await bumpEntitlementVersionAndPublish(transaction, input.tenantId);
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "addon.added",
          outcome: "success",
          resourceType: "tenant_addon",
          resourceId: addon.id,
          requestId: input.requestId,
        });
        return {
          id: addon.id,
          tenantId: addon.tenant_id,
          featureKey: input.request.featureKey,
          enabled: addon.enabled,
          grantedBy: addon.granted_by,
          expiresAt: addon.expires_at ? addon.expires_at.toISOString() : null,
          createdAt: addon.created_at.toISOString(),
        };
      });
    },
    async removeAddon(input) {
      await requireTenantOwner(database, input.tenantId, input.actorUserId);
      const feature = await database
        .selectFrom("app.feature_definitions")
        .select("id")
        .where("key", "=", input.featureKey)
        .executeTakeFirst();
      if (!feature) throw DomainError.notFound();

      await database.transaction().execute(async (transaction) => {
        const deleted = await transaction
          .deleteFrom("app.tenant_addons")
          .where("tenant_id", "=", input.tenantId)
          .where("feature_definition_id", "=", feature.id)
          .returning("id")
          .executeTakeFirst();
        if (!deleted) throw DomainError.notFound();
        await bumpEntitlementVersionAndPublish(transaction, input.tenantId);
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "addon.removed",
          outcome: "success",
          resourceType: "tenant_addon",
          resourceId: deleted.id,
          requestId: input.requestId,
        });
      });
    },
    async resolveEffectiveEntitlements(input) {
      await requireActiveTenantMember(database, input.tenantId, input.actorUserId);
      return database.transaction().execute((transaction) =>
        resolveWithinTransaction(transaction, input.tenantId),
      );
    },
    async listEntitlementSnapshotsAfter(input) {
      const rows = await database
        .selectFrom("app.entitlement_snapshot_outbox")
        .selectAll()
        .where("outbox_sequence", ">", String(input.afterSequence))
        .orderBy("outbox_sequence", "asc")
        .limit(input.limit)
        .execute();
      return {
        items: rows.map((row) => EntitlementSnapshotSchema.parse(row.payload)),
        nextAfterSequence:
          rows.length === 0 ? null : Number(rows[rows.length - 1]!.outbox_sequence),
      };
    },
  };
}
