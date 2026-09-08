import { z } from "zod";

import { BusinessMembershipSchema } from "./memberships.js";
import { SpendingCategorySchema } from "./spending-categories.js";

const TimestampSchema = z.string().datetime({ offset: true });
const VersionSchema = z.number().int().positive();
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const TimezoneSchema = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA timezone");

export const BusinessIndustryStatusSchema = z.enum(["active", "inactive"]);
export const BusinessIndustrySchema = z.strictObject({
  code: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  status: BusinessIndustryStatusSchema,
});
export type BusinessIndustry = z.infer<typeof BusinessIndustrySchema>;

export const BusinessIndustryListSchema = z.strictObject({
  items: z.array(BusinessIndustrySchema),
});
export type BusinessIndustryList = z.infer<typeof BusinessIndustryListSchema>;

export const BusinessStatusSchema = z.enum(["active", "archived"]);
export const SmallBusinessSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  name: z.string().min(1).max(100),
  industryCode: z.string().min(1).max(50),
  timezone: TimezoneSchema,
  baseCurrency: CurrencySchema,
  status: BusinessStatusSchema,
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type SmallBusiness = z.infer<typeof SmallBusinessSchema>;

export const BusinessCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  industryCode: z.string().trim().min(1).max(50).regex(/^[a-z0-9-]+$/),
  timezone: TimezoneSchema,
  baseCurrency: CurrencySchema,
});
export type BusinessCreateRequest = z.infer<
  typeof BusinessCreateRequestSchema
>;

export const BusinessUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    name: z.string().trim().min(1).max(100).optional(),
    industryCode: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    timezone: TimezoneSchema.optional(),
    baseCurrency: CurrencySchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.industryCode !== undefined ||
      value.timezone !== undefined ||
      value.baseCurrency !== undefined,
    { message: "At least one business change is required" },
  );
export type BusinessUpdateRequest = z.infer<
  typeof BusinessUpdateRequestSchema
>;

export const BusinessArchiveRequestSchema = z.strictObject({
  expectedVersion: VersionSchema,
});
export type BusinessArchiveRequest = z.infer<
  typeof BusinessArchiveRequestSchema
>;

export const BusinessBootstrapSchema = z.strictObject({
  business: SmallBusinessSchema,
  businessMembership: BusinessMembershipSchema,
  createdSpendingCategories: z.array(SpendingCategorySchema),
});
export type BusinessBootstrap = z.infer<typeof BusinessBootstrapSchema>;

export const BusinessListSchema = z.strictObject({
  items: z.array(SmallBusinessSchema),
});
export type BusinessList = z.infer<typeof BusinessListSchema>;

export const BusinessScopeParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
});
export type BusinessScopeParams = z.infer<typeof BusinessScopeParamsSchema>;
