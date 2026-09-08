import { z } from "zod";

import { TimestampSchema } from "./expenses.js";

export const ProviderKindSchema = z.enum([
  "openai",
  "openrouter",
  "anthropic",
  "google",
  "paddleocr",
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const CatalogStatusSchema = z.enum(["active", "disabled"]);
export type CatalogStatus = z.infer<typeof CatalogStatusSchema>;

export const AiOperationSchema = z.enum(["RECEIPT_OCR", "AI_SEARCH"]);
export type AiOperation = z.infer<typeof AiOperationSchema>;

const CatalogKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, "Key must be lowercase kebab/snake case");

export const ProviderConnectionSchema = z.strictObject({
  id: z.uuid(),
  key: CatalogKeySchema,
  providerKind: ProviderKindSchema,
  displayName: z.string().min(1).max(200),
  secretReference: z.uuid(),
  status: CatalogStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

export const ProviderConnectionCreateRequestSchema = z.strictObject({
  key: CatalogKeySchema,
  providerKind: ProviderKindSchema,
  displayName: z.string().min(1).max(200),
  secretValue: z.string().min(1),
});
export type ProviderConnectionCreateRequest = z.infer<
  typeof ProviderConnectionCreateRequestSchema
>;

export const ProviderConnectionUpdateRequestSchema = z
  .strictObject({
    displayName: z.string().min(1).max(200).optional(),
    status: CatalogStatusSchema.optional(),
    secretValue: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.status !== undefined ||
      value.secretValue !== undefined,
    { message: "At least one provider connection change is required" },
  );
export type ProviderConnectionUpdateRequest = z.infer<
  typeof ProviderConnectionUpdateRequestSchema
>;

export const ProviderConnectionListSchema = z.strictObject({
  items: z.array(ProviderConnectionSchema),
});
export type ProviderConnectionList = z.infer<
  typeof ProviderConnectionListSchema
>;

export const ProviderConnectionParamsSchema = z.strictObject({
  id: z.uuid(),
});
export type ProviderConnectionParams = z.infer<
  typeof ProviderConnectionParamsSchema
>;

export const AiModelSchema = z.strictObject({
  id: z.uuid(),
  providerConnectionId: z.uuid(),
  providerModelId: z.string().min(1).max(200),
  meteredModelKey: z.string().min(1).max(200),
  status: CatalogStatusSchema,
  createdAt: TimestampSchema,
});
export type AiModel = z.infer<typeof AiModelSchema>;

export const AiModelCreateRequestSchema = z.strictObject({
  providerConnectionId: z.uuid(),
  providerModelId: z.string().min(1).max(200),
  meteredModelKey: z.string().min(1).max(200),
});
export type AiModelCreateRequest = z.infer<typeof AiModelCreateRequestSchema>;

export const AiModelListSchema = z.strictObject({
  items: z.array(AiModelSchema),
});
export type AiModelList = z.infer<typeof AiModelListSchema>;

export const AiModeSchema = z.strictObject({
  id: z.uuid(),
  key: CatalogKeySchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  operation: AiOperationSchema,
  status: CatalogStatusSchema,
  createdAt: TimestampSchema,
});
export type AiMode = z.infer<typeof AiModeSchema>;

export const AiModeCreateRequestSchema = z.strictObject({
  key: CatalogKeySchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  operation: AiOperationSchema,
});
export type AiModeCreateRequest = z.infer<typeof AiModeCreateRequestSchema>;

export const AiModeListSchema = z.strictObject({
  items: z.array(AiModeSchema),
});
export type AiModeList = z.infer<typeof AiModeListSchema>;

export const AiModeParamsSchema = z.strictObject({
  aiModeId: z.uuid(),
});
export type AiModeParams = z.infer<typeof AiModeParamsSchema>;

export const AiModeRouteVersionSchema = z.strictObject({
  id: z.uuid(),
  aiModeId: z.uuid(),
  versionNumber: z.number().int().positive(),
  aiModelId: z.uuid(),
  isCurrent: z.boolean(),
  createdAt: TimestampSchema,
});
export type AiModeRouteVersion = z.infer<typeof AiModeRouteVersionSchema>;

export const AiModeRouteVersionCreateRequestSchema = z.strictObject({
  aiModelId: z.uuid(),
});
export type AiModeRouteVersionCreateRequest = z.infer<
  typeof AiModeRouteVersionCreateRequestSchema
>;
