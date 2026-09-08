import { z } from "zod";

import { TimestampSchema, VersionSchema } from "./expenses.js";

export const FeatureKeySchema = z.enum([
  "receipt_forwarding",
  "connected_mailbox_scan",
  "ai_search",
  "ocr_mode_fast",
  "ocr_mode_balanced",
  "ocr_mode_accurate",
]);
export type FeatureKey = z.infer<typeof FeatureKeySchema>;

export const LimitPeriodSchema = z.enum(["monthly", "unlimited"]);
export type LimitPeriod = z.infer<typeof LimitPeriodSchema>;

export const SubscriptionStatusSchema = z.enum([
  "trialing",
  "active",
  "canceled",
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const EntitlementSourceSchema = z.enum(["plan", "addon", "override"]);
export type EntitlementSource = z.infer<typeof EntitlementSourceSchema>;

export const PlanKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, "Plan key must be lowercase kebab/snake case");

export const PlanSchema = z.strictObject({
  id: z.uuid(),
  key: PlanKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  isActive: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Plan = z.infer<typeof PlanSchema>;

export const PlanCreateRequestSchema = z.strictObject({
  key: PlanKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
});
export type PlanCreateRequest = z.infer<typeof PlanCreateRequestSchema>;

export const PlanEntitlementInputSchema = z.strictObject({
  featureKey: FeatureKeySchema,
  isEnabled: z.boolean(),
  limitValue: z.number().int().nonnegative().nullable(),
  limitPeriod: LimitPeriodSchema.nullable(),
});
export type PlanEntitlementInput = z.infer<typeof PlanEntitlementInputSchema>;

export const PlanEntitlementSchema = z.strictObject({
  featureKey: FeatureKeySchema,
  isEnabled: z.boolean(),
  limitValue: z.number().int().nonnegative().nullable(),
  limitPeriod: LimitPeriodSchema.nullable(),
});
export type PlanEntitlement = z.infer<typeof PlanEntitlementSchema>;

export const PlanVersionSchema = z.strictObject({
  id: z.uuid(),
  planId: z.uuid(),
  versionNumber: z.number().int().positive(),
  effectiveAt: TimestampSchema,
  isCurrent: z.boolean(),
  entitlements: z.array(PlanEntitlementSchema),
  createdAt: TimestampSchema,
});
export type PlanVersion = z.infer<typeof PlanVersionSchema>;

export const PlanVersionCreateRequestSchema = z.strictObject({
  entitlements: z.array(PlanEntitlementInputSchema).min(1),
});
export type PlanVersionCreateRequest = z.infer<
  typeof PlanVersionCreateRequestSchema
>;

export const PlanWithVersionsSchema = PlanSchema.extend({
  versions: z.array(PlanVersionSchema),
});
export type PlanWithVersions = z.infer<typeof PlanWithVersionsSchema>;

export const PlanListSchema = z.strictObject({
  items: z.array(PlanWithVersionsSchema),
});
export type PlanList = z.infer<typeof PlanListSchema>;

export const ActivePlanSchema = z.strictObject({
  id: z.uuid(),
  key: PlanKeySchema,
  name: z.string(),
  description: z.string().nullable(),
  currentVersion: PlanVersionSchema,
});
export type ActivePlan = z.infer<typeof ActivePlanSchema>;

export const ActivePlanListSchema = z.strictObject({
  items: z.array(ActivePlanSchema),
});
export type ActivePlanList = z.infer<typeof ActivePlanListSchema>;

export const FeatureDefinitionSchema = z.strictObject({
  id: z.uuid(),
  key: FeatureKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  createdAt: TimestampSchema,
});
export type FeatureDefinition = z.infer<typeof FeatureDefinitionSchema>;

export const FeatureDefinitionCreateRequestSchema = z.strictObject({
  key: FeatureKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
});
export type FeatureDefinitionCreateRequest = z.infer<
  typeof FeatureDefinitionCreateRequestSchema
>;

export const TenantSubscriptionSchema = z.strictObject({
  tenantId: z.uuid(),
  planKey: PlanKeySchema,
  planVersionId: z.uuid(),
  status: SubscriptionStatusSchema,
  currentEntitlementVersion: z.number().int().positive(),
  startedAt: TimestampSchema,
  version: VersionSchema,
  updatedAt: TimestampSchema,
});
export type TenantSubscription = z.infer<typeof TenantSubscriptionSchema>;

export const TenantSubscriptionUpdateRequestSchema = z.strictObject({
  planKey: PlanKeySchema,
});
export type TenantSubscriptionUpdateRequest = z.infer<
  typeof TenantSubscriptionUpdateRequestSchema
>;

export const TenantAddonSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  featureKey: FeatureKeySchema,
  enabled: z.boolean(),
  grantedBy: z.string(),
  expiresAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type TenantAddon = z.infer<typeof TenantAddonSchema>;

export const TenantAddonCreateRequestSchema = z.strictObject({
  featureKey: FeatureKeySchema,
  reason: z.string().min(1).max(2000),
});
export type TenantAddonCreateRequest = z.infer<
  typeof TenantAddonCreateRequestSchema
>;

export const TenantAddonParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  featureKey: FeatureKeySchema,
});
export type TenantAddonParams = z.infer<typeof TenantAddonParamsSchema>;

export const EffectiveEntitlementSchema = z.strictObject({
  featureKey: FeatureKeySchema,
  isEnabled: z.boolean(),
  limitValue: z.number().int().nonnegative().nullable(),
  limitPeriod: LimitPeriodSchema.nullable(),
  source: EntitlementSourceSchema,
});
export type EffectiveEntitlement = z.infer<typeof EffectiveEntitlementSchema>;

export const EffectiveEntitlementListSchema = z.strictObject({
  items: z.array(EffectiveEntitlementSchema),
});
export type EffectiveEntitlementList = z.infer<
  typeof EffectiveEntitlementListSchema
>;

export const EntitlementSnapshotSchema = z.strictObject({
  tenantId: z.uuid(),
  entitlementVersion: z.number().int().positive(),
  entitlements: z.array(EffectiveEntitlementSchema),
});
export type EntitlementSnapshot = z.infer<typeof EntitlementSnapshotSchema>;

export const EntitlementSnapshotListSchema = z.strictObject({
  items: z.array(EntitlementSnapshotSchema),
  nextAfterSequence: z.number().int().nonnegative().nullable(),
});
export type EntitlementSnapshotList = z.infer<
  typeof EntitlementSnapshotListSchema
>;

export const EntitlementSnapshotQuerySchema = z.strictObject({
  afterSequence: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
export type EntitlementSnapshotQuery = z.infer<
  typeof EntitlementSnapshotQuerySchema
>;

export const TenantScopeParamsSchema = z.strictObject({
  tenantId: z.uuid(),
});
export type TenantScopeParams = z.infer<typeof TenantScopeParamsSchema>;

export const PlanParamsSchema = z.strictObject({
  planId: z.uuid(),
});
export type PlanParams = z.infer<typeof PlanParamsSchema>;
