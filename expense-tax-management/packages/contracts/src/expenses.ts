import { z } from "zod";

export const TimestampSchema = z.string().datetime({ offset: true });
export const DateOnlySchema = z.iso.date();
export const VersionSchema = z.number().int().positive();
export const TaxYearSchema = z.number().int().min(1_900).max(9_999);
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const DecimalMoneySchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  .refine((value) => Number(value) > 0, "Amount must be positive");

export const ExpenseStatusSchema = z.enum(["draft", "ready", "archived"]);
export type ExpenseStatus = z.infer<typeof ExpenseStatusSchema>;

export const ExpenseSourceSchema = z.enum(["manual", "ocr"]);
export type ExpenseSource = z.infer<typeof ExpenseSourceSchema>;

const ExpenseScopeFields = {
  personalProfileId: z.uuid().nullable().optional(),
  businessId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
  spendingCategoryId: z.uuid().nullable().optional(),
};

function validExpenseScope(value: {
  personalProfileId?: string | null | undefined;
  businessId?: string | null | undefined;
  projectId?: string | null | undefined;
}): boolean {
  const personal = value.personalProfileId != null;
  const business = value.businessId != null;
  return personal !== business && (!personal || value.projectId == null);
}

const ExpenseFields = {
  merchant: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).nullable().optional(),
  amount: DecimalMoneySchema,
  currency: CurrencySchema,
  incurredOn: DateOnlySchema,
};

export const ExpenseCreateRequestSchema = z
  .strictObject({ ...ExpenseScopeFields, ...ExpenseFields })
  .refine(validExpenseScope, {
    message: "Expense must target exactly one Personal profile or business",
  });
export type ExpenseCreateRequest = z.infer<typeof ExpenseCreateRequestSchema>;

export const ExpenseSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  createdByUserId: z.uuid(),
  personalProfileId: z.uuid().nullable(),
  businessId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  spendingCategoryId: z.uuid().nullable(),
  merchant: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable(),
  amount: DecimalMoneySchema,
  currency: CurrencySchema,
  incurredOn: DateOnlySchema,
  taxYear: z.number().int().min(1_900).max(9_999),
  source: ExpenseSourceSchema,
  status: ExpenseStatusSchema,
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Expense = z.infer<typeof ExpenseSchema>;

export const ExpenseUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    merchant: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
    amount: DecimalMoneySchema.optional(),
    currency: CurrencySchema.optional(),
    incurredOn: DateOnlySchema.optional(),
    projectId: z.uuid().nullable().optional(),
    spendingCategoryId: z.uuid().nullable().optional(),
    status: z.enum(["draft", "ready"]).optional(),
  })
  .refine(
    (value) =>
      value.merchant !== undefined ||
      value.description !== undefined ||
      value.amount !== undefined ||
      value.currency !== undefined ||
      value.incurredOn !== undefined ||
      value.projectId !== undefined ||
      value.spendingCategoryId !== undefined ||
      value.status !== undefined,
    { message: "At least one expense change is required" },
  );
export type ExpenseUpdateRequest = z.infer<typeof ExpenseUpdateRequestSchema>;

export const ExpenseArchiveRequestSchema = z.strictObject({
  expectedVersion: VersionSchema,
});
export type ExpenseArchiveRequest = z.infer<typeof ExpenseArchiveRequestSchema>;

export const PersonalExpenseCollectionParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  profileId: z.uuid(),
});
export type PersonalExpenseCollectionParams = z.infer<
  typeof PersonalExpenseCollectionParamsSchema
>;

export const BusinessExpenseCollectionParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
});
export type BusinessExpenseCollectionParams = z.infer<
  typeof BusinessExpenseCollectionParamsSchema
>;

export const PersonalExpenseParamsSchema = PersonalExpenseCollectionParamsSchema.extend({
  expenseId: z.uuid(),
});
export type PersonalExpenseParams = z.infer<typeof PersonalExpenseParamsSchema>;

export const BusinessExpenseParamsSchema = BusinessExpenseCollectionParamsSchema.extend({
  expenseId: z.uuid(),
});
export type BusinessExpenseParams = z.infer<typeof BusinessExpenseParamsSchema>;

export const ExpenseListSchema = z.strictObject({
  items: z.array(ExpenseSchema),
  nextCursor: z.string().nullable(),
});
export type ExpenseList = z.infer<typeof ExpenseListSchema>;
