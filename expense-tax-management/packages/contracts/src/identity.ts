import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });

export const UserStatusSchema = z.enum(["active", "disabled"]);

export type UserStatus = z.infer<typeof UserStatusSchema>;

export const UserSchema = z.strictObject({
  id: z.uuid(),
  primaryEmail: z.string().email(),
  displayName: z.string().min(1).max(100),
  status: UserStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type User = z.infer<typeof UserSchema>;

export const AuthenticatedUserSchema = UserSchema.pick({
  id: true,
  primaryEmail: true,
  displayName: true,
  status: true,
});

export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;

export const CurrentUserResponseSchema = z.strictObject({
  user: AuthenticatedUserSchema,
});

export type CurrentUserResponse = z.infer<typeof CurrentUserResponseSchema>;

export const IdentityProvisioningRequestSchema = z.strictObject({
  issuer: z.url(),
  subject: z.string().trim().min(1).max(255),
  email: z.string().trim().toLowerCase().pipe(z.email()),
  emailVerified: z.literal(true),
  displayName: z.string().trim().min(1).max(100),
});

export type IdentityProvisioningRequest = z.infer<
  typeof IdentityProvisioningRequestSchema
>;

export const IdentityProvisioningResponseSchema = z.strictObject({
  user: UserSchema,
});

export type IdentityProvisioningResponse = z.infer<
  typeof IdentityProvisioningResponseSchema
>;
