import { z } from "zod";

import { TimestampSchema, VersionSchema } from "./expenses.js";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const FileContentTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
export type FileContentType = z.infer<typeof FileContentTypeSchema>;

export const ExpenseFileStatusSchema = z.enum([
  "PENDING",
  "READY",
  "FAILED",
  "DELETED",
]);
export type ExpenseFileStatus = z.infer<typeof ExpenseFileStatusSchema>;

export const ThumbnailStatusSchema = z.enum([
  "pending",
  "ready",
  "skipped",
  "failed",
]);
export type ThumbnailStatus = z.infer<typeof ThumbnailStatusSchema>;

export const UploadSessionStatusSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "EXPIRED",
]);
export type UploadSessionStatus = z.infer<typeof UploadSessionStatusSchema>;

export const ExpenseFileSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  personalProfileId: z.uuid().nullable(),
  businessId: z.uuid().nullable(),
  expenseId: z.uuid().nullable(),
  originalFilename: z.string().min(1).max(255),
  contentType: FileContentTypeSchema,
  sizeBytes: z.int().nonnegative().nullable(),
  sha256Hex: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  storageKey: z.string().min(1),
  thumbnailStorageKey: z.string().min(1).nullable(),
  thumbnailStatus: ThumbnailStatusSchema,
  status: ExpenseFileStatusSchema,
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ExpenseFile = z.infer<typeof ExpenseFileSchema>;

export const UploadSessionSchema = z.strictObject({
  id: z.uuid(),
  expenseFileId: z.uuid(),
  status: UploadSessionStatusSchema,
  expiresAt: TimestampSchema,
  confirmedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type UploadSession = z.infer<typeof UploadSessionSchema>;

export const UploadTargetSchema = z.strictObject({
  url: z.string().min(1),
  method: z.literal("PUT"),
  requiredHeaders: z.record(z.string(), z.string()),
  expiresAt: TimestampSchema,
});
export type UploadTarget = z.infer<typeof UploadTargetSchema>;

export const CreateUploadSessionRequestSchema = z.strictObject({
  originalFilename: z.string().min(1).max(255),
  contentType: FileContentTypeSchema,
  expenseId: z.uuid().optional(),
  expectedSizeBytes: z.int().positive().max(MAX_UPLOAD_BYTES).optional(),
});
export type CreateUploadSessionRequest = z.infer<
  typeof CreateUploadSessionRequestSchema
>;

export const CreateUploadSessionResponseSchema = z.strictObject({
  file: ExpenseFileSchema,
  uploadSession: UploadSessionSchema,
  uploadTarget: UploadTargetSchema,
});
export type CreateUploadSessionResponse = z.infer<
  typeof CreateUploadSessionResponseSchema
>;

export const PersonalFileCollectionParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  profileId: z.uuid(),
});
export type PersonalFileCollectionParams = z.infer<
  typeof PersonalFileCollectionParamsSchema
>;

export const BusinessFileCollectionParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
});
export type BusinessFileCollectionParams = z.infer<
  typeof BusinessFileCollectionParamsSchema
>;

export const PersonalFileParamsSchema =
  PersonalFileCollectionParamsSchema.extend({
    fileId: z.uuid(),
  });
export type PersonalFileParams = z.infer<typeof PersonalFileParamsSchema>;

export const BusinessFileParamsSchema =
  BusinessFileCollectionParamsSchema.extend({
    fileId: z.uuid(),
  });
export type BusinessFileParams = z.infer<typeof BusinessFileParamsSchema>;

export const PersonalUploadSessionParamsSchema =
  PersonalFileCollectionParamsSchema.extend({
    sessionId: z.uuid(),
  });
export type PersonalUploadSessionParams = z.infer<
  typeof PersonalUploadSessionParamsSchema
>;

export const BusinessUploadSessionParamsSchema =
  BusinessFileCollectionParamsSchema.extend({
    sessionId: z.uuid(),
  });
export type BusinessUploadSessionParams = z.infer<
  typeof BusinessUploadSessionParamsSchema
>;

export const FileListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});
export type FileListQuery = z.infer<typeof FileListQuerySchema>;

export const FileListSchema = z.strictObject({
  items: z.array(ExpenseFileSchema),
  nextCursor: z.string().nullable(),
});
export type FileList = z.infer<typeof FileListSchema>;

export const FileReadUrlResponseSchema = z.strictObject({
  url: z.string().min(1),
  expiresAt: TimestampSchema,
});
export type FileReadUrlResponse = z.infer<typeof FileReadUrlResponseSchema>;

export const FileContentQuerySchema = z.strictObject({
  expires: z.string().regex(/^\d+$/),
  signature: z.string().min(1),
});
export type FileContentQuery = z.infer<typeof FileContentQuerySchema>;

export const InternalFileParamsSchema = z.strictObject({
  fileId: z.uuid(),
});
export type InternalFileParams = z.infer<typeof InternalFileParamsSchema>;
