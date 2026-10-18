import { z } from "zod";

import {
  CurrencySchema,
  DateOnlySchema,
  DecimalMoneySchema,
  NonNegativeMoneySchema,
  VersionSchema,
} from "./expenses.js";
import { ProcessingJobSchema } from "./processing-jobs.js";

export const OcrModeKeySchema = z.enum([
  "ocr_mode_fast",
  "ocr_mode_balanced",
  "ocr_mode_accurate",
]);
export type OcrModeKey = z.infer<typeof OcrModeKeySchema>;

export const CaptureOcrReviewPolicySchema = z.literal("capture_required_fields_v1");
export type CaptureOcrReviewPolicy = z.infer<typeof CaptureOcrReviewPolicySchema>;

export const CaptureOcrIssueCodeSchema = z.enum([
  "merchant_missing",
  "total_missing",
  "total_zero",
  "currency_missing",
  "date_missing",
  "tax_missing",
  "tax_zero_requires_confirmation",
  "tax_exceeds_total",
]);
export type CaptureOcrIssueCode = z.infer<typeof CaptureOcrIssueCodeSchema>;

export const CaptureOcrPartialFieldsV1Schema = z.strictObject({
  merchant: z.string().trim().min(1).max(200).nullable(),
  total: NonNegativeMoneySchema.nullable(),
  currency: CurrencySchema.nullable(),
  incurredOn: DateOnlySchema.nullable(),
  taxAmount: NonNegativeMoneySchema.nullable(),
});
export type CaptureOcrPartialFieldsV1 = z.infer<
  typeof CaptureOcrPartialFieldsV1Schema
>;

function moneyToMinorUnits(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

const CaptureOcrCompleteFieldsV1Schema = z
  .strictObject({
    merchant: z.string().trim().min(1).max(200),
    total: DecimalMoneySchema,
    currency: CurrencySchema,
    incurredOn: DateOnlySchema,
    taxAmount: NonNegativeMoneySchema,
  })
  .refine(
    (value) =>
      moneyToMinorUnits(value.taxAmount) <= moneyToMinorUnits(value.total),
    { message: "Tax amount must not exceed total", path: ["taxAmount"] },
  );

export const CaptureOcrResultV1Schema = z.discriminatedUnion("outcome", [
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.literal("complete"),
    fields: CaptureOcrCompleteFieldsV1Schema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.literal("needs_input"),
    fields: CaptureOcrPartialFieldsV1Schema,
    issues: z.array(CaptureOcrIssueCodeSchema).min(1),
  }),
]);
export type CaptureOcrResultV1 = z.infer<typeof CaptureOcrResultV1Schema>;

export const CaptureOcrTaxInputV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("amount"), amount: DecimalMoneySchema }),
  z.strictObject({ kind: z.literal("no_tax") }),
]);
export type CaptureOcrTaxInputV1 = z.infer<typeof CaptureOcrTaxInputV1Schema>;

export const CaptureOcrCompleteRequestV1Schema = z
  .strictObject({
    expectedJobVersion: VersionSchema,
    merchant: z.string().trim().min(1).max(200),
    total: DecimalMoneySchema,
    currency: CurrencySchema,
    incurredOn: DateOnlySchema,
    tax: CaptureOcrTaxInputV1Schema,
  })
  .refine(
    (value) =>
      value.tax.kind === "no_tax" ||
      moneyToMinorUnits(value.tax.amount) <= moneyToMinorUnits(value.total),
    { message: "Tax amount must not exceed total", path: ["tax", "amount"] },
  );
export type CaptureOcrCompleteRequestV1 = z.infer<
  typeof CaptureOcrCompleteRequestV1Schema
>;

export const OcrExtractionResultV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  merchant: z.string().trim().min(1).max(200),
  amount: DecimalMoneySchema,
  currency: CurrencySchema,
  incurredOn: DateOnlySchema,
  orderNumber: z.string().trim().min(1).max(200).optional(),
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
  reviewPolicy: CaptureOcrReviewPolicySchema.optional(),
});
export type OcrJobInputV1 = z.infer<typeof OcrJobInputV1Schema>;

export const CreateOcrJobRequestSchema = z.strictObject({
  modeKey: OcrModeKeySchema,
  reviewPolicy: CaptureOcrReviewPolicySchema.optional(),
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
