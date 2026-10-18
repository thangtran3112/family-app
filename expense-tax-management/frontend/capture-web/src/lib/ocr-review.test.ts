import { describe, expect, it, vi } from "vitest";

import {
  buildCompletionRequest,
  formValuesFromReview,
  removeReviewReceipt,
  validateOcrReview,
  type OcrReviewValues,
} from "./ocr-review";

const valid: OcrReviewValues = {
  merchant: "Shop",
  total: "12.00",
  currency: "USD",
  incurredOn: "2026-10-18",
  taxAmount: "1.25",
  noTax: false,
};

describe("OCR review validation", () => {
  it.each([
    ["merchant", { merchant: "" }],
    ["total", { total: "" }],
    ["currency", { currency: "" }],
    ["incurredOn", { incurredOn: "" }],
    ["taxAmount", { taxAmount: "" }],
  ] as const)("requires %s", (field, override) => {
    expect(validateOcrReview({ ...valid, ...override })[field]).toBeTruthy();
  });

  it("rejects a zero total", () => {
    expect(validateOcrReview({ ...valid, total: "0.00" }).total).toBeTruthy();
  });

  it("rejects zero tax until No tax is selected", () => {
    expect(validateOcrReview({ ...valid, taxAmount: "0.00" }).taxAmount).toBeTruthy();
    expect(validateOcrReview({ ...valid, taxAmount: "0.00", noTax: true })).toEqual({});
  });

  it("builds the explicit No tax request that persists zero", () => {
    expect(buildCompletionRequest({ ...valid, taxAmount: "0.00", noTax: true }, 4)).toMatchObject({
      expectedJobVersion: 4,
      tax: { kind: "no_tax" },
    });
  });

  it("prefills every OCR field without locking it", () => {
    expect(formValuesFromReview({
      merchant: "Prefilled",
      total: "8.50",
      currency: "CAD",
      incurredOn: "2026-10-17",
      taxAmount: null,
    })).toEqual({
      merchant: "Prefilled",
      total: "8.50",
      currency: "CAD",
      incurredOn: "2026-10-17",
      taxAmount: "",
      noTax: false,
    });
  });

  it.each(["2026-02-31", "2025-02-29", "2026-04-31"])("rejects impossible date %s", (incurredOn) => {
    expect(validateOcrReview({ ...valid, incurredOn }).incurredOn).toBeTruthy();
  });

  it.each(["2024-02-29", "2026-04-30"])("accepts exact calendar date %s", (incurredOn) => {
    expect(validateOcrReview({ ...valid, incurredOn }).incurredOn).toBeUndefined();
  });
});

describe("review removal", () => {
  it("keeps the local item when server deletion fails", async () => {
    const deleteServer = vi.fn().mockRejectedValue(new Error("delete failed"));
    const deleteLocal = vi.fn();

    await expect(removeReviewReceipt(deleteServer, deleteLocal)).rejects.toThrow("delete failed");

    expect(deleteLocal).not.toHaveBeenCalled();
  });

  it("removes the local item after server deletion", async () => {
    const order: string[] = [];
    await removeReviewReceipt(
      async () => { order.push("server"); },
      async () => { order.push("local"); },
    );
    expect(order).toEqual(["server", "local"]);
  });
});
