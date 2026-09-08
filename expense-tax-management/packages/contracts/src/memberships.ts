import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });
const VersionSchema = z.number().int().positive();

export const TenantRoleSchema = z.enum(["owner", "admin", "member"]);
export const ProfileRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const BusinessRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const MembershipStatusSchema = z.enum(["active", "inactive"]);

export type TenantRole = z.infer<typeof TenantRoleSchema>;
export type ProfileRole = z.infer<typeof ProfileRoleSchema>;
export type BusinessRole = z.infer<typeof BusinessRoleSchema>;
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

export const TenantMembershipSchema = z.strictObject({
  tenantId: z.uuid(),
  userId: z.uuid(),
  role: TenantRoleSchema,
  status: MembershipStatusSchema,
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type TenantMembership = z.infer<typeof TenantMembershipSchema>;

export const PersonalMembershipSchema = z.strictObject({
  personalProfileId: z.uuid(),
  tenantId: z.uuid(),
  userId: z.uuid(),
  role: ProfileRoleSchema,
  status: MembershipStatusSchema,
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type PersonalMembership = z.infer<typeof PersonalMembershipSchema>;

export const BusinessMembershipSchema = z.strictObject({
  businessId: z.uuid(),
  tenantId: z.uuid(),
  userId: z.uuid(),
  role: BusinessRoleSchema,
  status: MembershipStatusSchema,
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type BusinessMembership = z.infer<typeof BusinessMembershipSchema>;

const NoInvitationGrantSchema = z.strictObject({
  type: z.literal("none"),
});

const PersonalInvitationGrantSchema = z.strictObject({
  type: z.literal("personal"),
  profileId: z.uuid(),
  role: ProfileRoleSchema,
});

const BusinessInvitationGrantSchema = z.strictObject({
  type: z.literal("business"),
  businessId: z.uuid(),
  role: BusinessRoleSchema,
});

export const TenantInvitationGrantSchema = z.discriminatedUnion("type", [
  NoInvitationGrantSchema,
  PersonalInvitationGrantSchema,
  BusinessInvitationGrantSchema,
]);

export type TenantInvitationGrant = z.infer<
  typeof TenantInvitationGrantSchema
>;

export const TenantInvitationCreateRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  tenantRole: TenantRoleSchema,
  grant: TenantInvitationGrantSchema,
});

export type TenantInvitationCreateRequest = z.infer<
  typeof TenantInvitationCreateRequestSchema
>;

export const TenantInvitationSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  email: z.string().email(),
  tenantRole: TenantRoleSchema,
  grant: TenantInvitationGrantSchema,
  expiresAt: TimestampSchema,
  acceptedAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  createdByUserId: z.uuid(),
  acceptedByUserId: z.uuid().nullable(),
  createdAt: TimestampSchema,
});

export type TenantInvitation = z.infer<typeof TenantInvitationSchema>;

export const TenantInvitationCreatedSchema = z.strictObject({
  invitation: TenantInvitationSchema,
  invitationToken: z.string().min(32).max(512),
});

export type TenantInvitationCreated = z.infer<
  typeof TenantInvitationCreatedSchema
>;

export const TenantInvitationAcceptRequestSchema = z.strictObject({
  token: z.string().min(32).max(512),
});

export type TenantInvitationAcceptRequest = z.infer<
  typeof TenantInvitationAcceptRequestSchema
>;

export const TenantMembershipUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    role: TenantRoleSchema.optional(),
    status: MembershipStatusSchema.optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: "Role or status change is required",
  });

export type TenantMembershipUpdateRequest = z.infer<
  typeof TenantMembershipUpdateRequestSchema
>;

export const PersonalMembershipCreateRequestSchema = z.strictObject({
  userId: z.uuid(),
  role: ProfileRoleSchema,
});

export type PersonalMembershipCreateRequest = z.infer<
  typeof PersonalMembershipCreateRequestSchema
>;

export const BusinessMembershipCreateRequestSchema = z.strictObject({
  userId: z.uuid(),
  role: BusinessRoleSchema,
});
export type BusinessMembershipCreateRequest = z.infer<
  typeof BusinessMembershipCreateRequestSchema
>;

export const BusinessMembershipUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    role: BusinessRoleSchema.optional(),
    status: MembershipStatusSchema.optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: "Role or status change is required",
  });
export type BusinessMembershipUpdateRequest = z.infer<
  typeof BusinessMembershipUpdateRequestSchema
>;

export const PersonalMembershipUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    role: ProfileRoleSchema.optional(),
    status: MembershipStatusSchema.optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: "Role or status change is required",
  });

export type PersonalMembershipUpdateRequest = z.infer<
  typeof PersonalMembershipUpdateRequestSchema
>;

export const TenantMembershipParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  userId: z.uuid(),
});

export type TenantMembershipParams = z.infer<
  typeof TenantMembershipParamsSchema
>;

export const PersonalMembershipScopeParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  profileId: z.uuid(),
});

export type PersonalMembershipScopeParams = z.infer<
  typeof PersonalMembershipScopeParamsSchema
>;

export const PersonalMembershipParamsSchema =
  PersonalMembershipScopeParamsSchema.extend({ userId: z.uuid() });

export type PersonalMembershipParams = z.infer<
  typeof PersonalMembershipParamsSchema
>;

export const BusinessMembershipScopeParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
});
export type BusinessMembershipScopeParams = z.infer<
  typeof BusinessMembershipScopeParamsSchema
>;

export const BusinessMembershipParamsSchema =
  BusinessMembershipScopeParamsSchema.extend({ userId: z.uuid() });
export type BusinessMembershipParams = z.infer<
  typeof BusinessMembershipParamsSchema
>;

export const TenantMembershipListSchema = z.strictObject({
  items: z.array(TenantMembershipSchema),
});

export type TenantMembershipList = z.infer<
  typeof TenantMembershipListSchema
>;

export const PersonalMembershipListSchema = z.strictObject({
  items: z.array(PersonalMembershipSchema),
});

export type PersonalMembershipList = z.infer<
  typeof PersonalMembershipListSchema
>;

export const BusinessMembershipListSchema = z.strictObject({
  items: z.array(BusinessMembershipSchema),
});
export type BusinessMembershipList = z.infer<
  typeof BusinessMembershipListSchema
>;
