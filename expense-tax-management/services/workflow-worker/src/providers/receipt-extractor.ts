import { ApplicationFailure } from "@temporalio/activity";
import {
  CaptureOcrResultV1Schema,
  OcrExtractionResultV1Schema,
  type CaptureOcrReviewPolicy,
  type CaptureOcrResultV1,
  type OcrExtractionResultV1,
} from "@expense-tax/contracts";

import type { ReceiptRoute } from "./openai-ocr.js";

export interface ReceiptObservation {
  readonly merchant: string | null;
  readonly total: string | null;
  readonly currency: string | null;
  readonly incurredOn: string | null;
  readonly taxAmount: string | null;
  readonly orderNumber?: string;
  readonly notes?: string;
  readonly confidence: number;
}

export type ReceiptExtraction = OcrExtractionResultV1 | CaptureOcrResultV1;
export type ReceiptExtractor = (
  data: Uint8Array,
  route: ReceiptRoute,
  reviewPolicy?: CaptureOcrReviewPolicy,
) => ReceiptExtraction | Promise<ReceiptExtraction>;

type ReceiptProviderResult = ReceiptObservation | OcrExtractionResultV1;

export interface ReceiptExtractorProviders {
  readonly openai: (data: Uint8Array, route: ReceiptRoute) => ReceiptProviderResult | Promise<ReceiptProviderResult>;
  readonly fake: (data: Uint8Array) => OcrExtractionResultV1;
  readonly warn?: (message: string) => void;
}

const malformed = () => ApplicationFailure.retryable("OCR model output invalid", "OcrExtractionMalformed");
const zeroAmount = () => ApplicationFailure.nonRetryable("Document total is zero", "OcrZeroAmount");

function asObservation(result: ReceiptProviderResult): ReceiptObservation {
  if ("total" in result) return result;
  return {
    merchant: result.merchant,
    total: result.amount,
    currency: result.currency,
    incurredOn: result.incurredOn,
    taxAmount: null,
    ...(result.orderNumber === undefined ? {} : { orderNumber: result.orderNumber }),
    ...(result.notes === undefined ? {} : { notes: result.notes }),
    confidence: result.confidence,
  };
}

export function evaluateReceiptObservation(
  observation: ReceiptObservation,
  reviewPolicy?: CaptureOcrReviewPolicy,
): ReceiptExtraction {
  if (reviewPolicy === "capture_required_fields_v1") {
    const fields = {
      merchant: observation.merchant,
      total: observation.total,
      currency: observation.currency,
      incurredOn: observation.incurredOn,
      taxAmount: observation.taxAmount,
    };
    const issues = [
      ...(fields.merchant === null ? ["merchant_missing" as const] : []),
      ...(fields.total === null
        ? ["total_missing" as const]
        : fields.total === "0.00" ? ["total_zero" as const] : []),
      ...(fields.currency === null ? ["currency_missing" as const] : []),
      ...(fields.incurredOn === null ? ["date_missing" as const] : []),
      ...(fields.taxAmount === null
        ? ["tax_missing" as const]
        : fields.taxAmount === "0.00"
          ? ["tax_zero_requires_confirmation" as const]
          : fields.total !== null && Number(fields.total) > 0 && Number(fields.taxAmount) > Number(fields.total)
            ? ["tax_exceeds_total" as const]
            : []),
    ];
    return CaptureOcrResultV1Schema.parse(
      issues.length === 0
        ? { schemaVersion: 1, outcome: "complete", fields }
        : { schemaVersion: 1, outcome: "needs_input", fields, issues },
    );
  }

  if (observation.total === "0.00") throw zeroAmount();
  const parsed = OcrExtractionResultV1Schema.safeParse({
    schemaVersion: 1,
    merchant: observation.merchant,
    amount: observation.total,
    currency: observation.currency,
    incurredOn: observation.incurredOn,
    ...(observation.orderNumber === undefined ? {} : { orderNumber: observation.orderNumber }),
    ...(observation.notes === undefined ? {} : { notes: observation.notes }),
    confidence: observation.confidence,
  });
  if (!parsed.success) throw malformed();
  return parsed.data;
}

export function createReceiptExtractor({
  openai,
  fake,
  warn = (message) => console.warn(message),
}: ReceiptExtractorProviders): ReceiptExtractor {
  return (data, route, reviewPolicy) => {
    switch (route.providerKind) {
      case "openai": {
        const result = openai(data, route);
        return result instanceof Promise
          ? result.then((value) => evaluateReceiptObservation(asObservation(value), reviewPolicy))
          : evaluateReceiptObservation(asObservation(result), reviewPolicy);
      }
      case "fake":
        warn("receipt OCR is using the fake provider");
        return evaluateReceiptObservation(asObservation(fake(data)), reviewPolicy);
      default:
        throw ApplicationFailure.nonRetryable(
          `Unsupported OCR provider "${route.providerKind}"`,
          "OcrUnsupportedProvider",
        );
    }
  };
}
