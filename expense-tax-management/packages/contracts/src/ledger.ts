import { z } from "zod";

import {
  DateOnlySchema,
  DecimalMoneySchema,
  ExpenseListSchema,
  ExpenseStatusSchema,
} from "./expenses.js";
import { TaxTreatmentReviewStatusSchema } from "./tax-treatments.js";

export const LedgerSortSchema = z.enum([
  "incurredOn",
  "amount",
  "merchant",
  "createdAt",
]);
export type LedgerSort = z.infer<typeof LedgerSortSchema>;

export const LedgerDirectionSchema = z.enum(["asc", "desc"]);
export type LedgerDirection = z.infer<typeof LedgerDirectionSchema>;

export const LedgerCursorSchema = z.string().trim().min(1).max(4_096);
export type LedgerCursor = z.infer<typeof LedgerCursorSchema>;

export const LedgerQuerySchema = z
  .strictObject({
    incurredFrom: DateOnlySchema.optional(),
    incurredTo: DateOnlySchema.optional(),
    amountMin: DecimalMoneySchema.optional(),
    amountMax: DecimalMoneySchema.optional(),
    status: ExpenseStatusSchema.optional(),
    spendingCategoryId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    taxReviewStatus: TaxTreatmentReviewStatusSchema.optional(),
    sort: LedgerSortSchema.default("incurredOn"),
    direction: LedgerDirectionSchema.default("desc"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: LedgerCursorSchema.optional(),
  })
  .refine(
    (value) =>
      value.incurredFrom === undefined ||
      value.incurredTo === undefined ||
      value.incurredFrom <= value.incurredTo,
    { message: "incurredFrom must not exceed incurredTo" },
  )
  .refine(
    (value) =>
      value.amountMin === undefined ||
      value.amountMax === undefined ||
      Number(value.amountMin) <= Number(value.amountMax),
    { message: "amountMin must not exceed amountMax" },
  );
export type LedgerQuery = z.infer<typeof LedgerQuerySchema>;

export const LedgerListResponseSchema = ExpenseListSchema;
export type LedgerListResponse = z.infer<typeof LedgerListResponseSchema>;
