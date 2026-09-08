import { z } from "zod";

import { DateOnlySchema, TaxYearSchema, TimestampSchema } from "./expenses.js";

const TaxonomyIdSchema = z.uuid();

export const TaxonomyVersionStatusSchema = z.enum(["active", "superseded"]);
export type TaxonomyVersionStatus = z.infer<typeof TaxonomyVersionStatusSchema>;

export const TaxonomyVersionSchema = z.strictObject({
  id: TaxonomyIdSchema,
  jurisdictionCode: z.literal("US-FEDERAL"),
  taxYear: TaxYearSchema,
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  status: TaxonomyVersionStatusSchema,
  sourceUrl: z.url(),
  sourceRevision: z.string().min(1).max(100),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: TimestampSchema,
});
export type TaxonomyVersion = z.infer<typeof TaxonomyVersionSchema>;

export const TaxCategoryDefinitionStatusSchema = z.enum(["active", "inactive"]);
export const TaxCategoryDefinitionSchema = z.strictObject({
  id: z.uuid(),
  taxonomyVersionId: TaxonomyIdSchema,
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable(),
  officialForm: z.string().max(100).nullable(),
  officialLine: z.string().max(100).nullable(),
  status: TaxCategoryDefinitionStatusSchema,
  sortOrder: z.number().int().positive(),
});
export type TaxCategoryDefinition = z.infer<typeof TaxCategoryDefinitionSchema>;

export const TaxonomyVersionListSchema = z.strictObject({
  items: z.array(TaxonomyVersionSchema),
});
export type TaxonomyVersionList = z.infer<typeof TaxonomyVersionListSchema>;

export const TaxCategoryDefinitionListSchema = z.strictObject({
  items: z.array(TaxCategoryDefinitionSchema),
});
export type TaxCategoryDefinitionList = z.infer<
  typeof TaxCategoryDefinitionListSchema
>;

export const TaxonomyVersionParamsSchema = z.strictObject({
  taxonomyVersionId: z.uuid(),
});
export type TaxonomyVersionParams = z.infer<typeof TaxonomyVersionParamsSchema>;

export { DateOnlySchema };
