import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });
const VersionSchema = z.number().int().positive();
const ColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const IconSchema = z.string().trim().min(1).max(50).regex(/^[a-z0-9-]+$/);

export const SpendingCategoryStatusSchema = z.enum(["active", "archived"]);
export type SpendingCategoryStatus = z.infer<
  typeof SpendingCategoryStatusSchema
>;

export const SpendingCategorySchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  templateKey: z.string().min(1).max(100).nullable(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable(),
  color: ColorSchema,
  icon: IconSchema,
  status: SpendingCategoryStatusSchema,
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type SpendingCategory = z.infer<typeof SpendingCategorySchema>;

export const SpendingCategoryCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  color: ColorSchema,
  icon: IconSchema,
});

export type SpendingCategoryCreateRequest = z.infer<
  typeof SpendingCategoryCreateRequestSchema
>;

export const SpendingCategoryUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    color: ColorSchema.optional(),
    icon: IconSchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.color !== undefined ||
      value.icon !== undefined,
    { message: "At least one category change is required" },
  );

export type SpendingCategoryUpdateRequest = z.infer<
  typeof SpendingCategoryUpdateRequestSchema
>;

export const SpendingCategoryArchiveRequestSchema = z.strictObject({
  expectedVersion: VersionSchema,
});

export type SpendingCategoryArchiveRequest = z.infer<
  typeof SpendingCategoryArchiveRequestSchema
>;

export const SpendingCategoryListSchema = z.strictObject({
  items: z.array(SpendingCategorySchema),
});

export type SpendingCategoryList = z.infer<typeof SpendingCategoryListSchema>;

export const SpendingCategoryParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  categoryId: z.uuid(),
});

export type SpendingCategoryParams = z.infer<
  typeof SpendingCategoryParamsSchema
>;
