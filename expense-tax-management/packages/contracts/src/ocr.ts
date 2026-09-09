import { z } from "zod";

import {
  CurrencySchema,
  DateOnlySchema,
  DecimalMoneySchema,
} from "./expenses.js";
import { ProcessingJobSchema } from "./processing-jobs.js";

export const OcrModeKeySchema = z.enum([
  "ocr_mode_fast",
  "ocr_mode_balanced",
  "ocr_mode_accurate",
]);
export type OcrModeKey = z.infer<typeof OcrModeKeySchema>;

export const OcrExtractionResultV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  merchant: z.string().trim().min(1).max(200),
  amount: DecimalMoneySchema,
  currency: CurrencySchema,
  incurredOn: DateOnlySchema,
  notes: z.string().trim().max(2000).optional(),
  confidence: z.number().min(0).max(1),
});
export type OcrExtractionResultV1 = z.infer<typeof OcrExtractionResultV1Schema>;

export const OcrJobInputV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  fileId: z.uuid(),
  modeKey: OcrModeKeySchema,
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  tenantId: z.uuid(),
});
export type OcrJobInputV1 = z.infer<typeof OcrJobInputV1Schema>;

export const CreateOcrJobRequestSchema = z.strictObject({
  modeKey: OcrModeKeySchema,
});
export type CreateOcrJobRequest = z.infer<typeof CreateOcrJobRequestSchema>;

export const PersonalOcrJobParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  profileId: z.uuid(),
  fileId: z.uuid(),
});
export type PersonalOcrJobParams = z.infer<typeof PersonalOcrJobParamsSchema>;

export const BusinessOcrJobParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
  fileId: z.uuid(),
});
export type BusinessOcrJobParams = z.infer<typeof BusinessOcrJobParamsSchema>;

export const OcrJobListSchema = z.strictObject({
  items: z.array(ProcessingJobSchema),
});
export type OcrJobList = z.infer<typeof OcrJobListSchema>;
