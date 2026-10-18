import type { CaptureOcrCompleteRequestV1, CaptureOcrPartialFieldsV1 } from "@expense-tax/contracts";

export interface OcrReviewValues {
  merchant: string;
  total: string;
  currency: string;
  incurredOn: string;
  taxAmount: string;
  noTax: boolean;
}

export type OcrReviewErrors = Partial<Record<keyof OcrReviewValues, string>>;

const moneyPattern = /^\d+(?:\.\d{1,2})?$/;

function positiveMoney(value: string): boolean {
  return moneyPattern.test(value) && Number(value) > 0;
}

function exactCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

export function validateOcrReview(values: OcrReviewValues): OcrReviewErrors {
  const errors: OcrReviewErrors = {};
  if (!values.merchant.trim()) errors.merchant = "Merchant is required";
  if (!positiveMoney(values.total)) errors.total = "Total must be greater than zero";
  if (!/^[A-Z]{3}$/.test(values.currency)) errors.currency = "Use a three-letter currency code";
  if (!exactCalendarDate(values.incurredOn)) {
    errors.incurredOn = "Date is required";
  }
  if (!values.noTax) {
    if (!positiveMoney(values.taxAmount)) {
      errors.taxAmount = "Enter tax greater than zero or select No tax";
    } else if (positiveMoney(values.total) && Number(values.taxAmount) > Number(values.total)) {
      errors.taxAmount = "Tax cannot exceed total";
    }
  }
  return errors;
}

export function buildCompletionRequest(
  values: OcrReviewValues,
  expectedJobVersion: number,
): CaptureOcrCompleteRequestV1 {
  return {
    expectedJobVersion,
    merchant: values.merchant.trim(),
    total: values.total,
    currency: values.currency.trim(),
    incurredOn: values.incurredOn,
    tax: values.noTax ? { kind: "no_tax" } : { kind: "amount", amount: values.taxAmount },
  };
}

export function formValuesFromReview(fields: CaptureOcrPartialFieldsV1): OcrReviewValues {
  return {
    merchant: fields.merchant ?? "",
    total: fields.total ?? "",
    currency: fields.currency ?? "",
    incurredOn: fields.incurredOn ?? "",
    taxAmount: fields.taxAmount ?? "",
    noTax: false,
  };
}

export async function removeReviewReceipt(
  deleteServer: () => Promise<void>,
  deleteLocal: () => Promise<void>,
): Promise<void> {
  await deleteServer();
  await deleteLocal();
}
