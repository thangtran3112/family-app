import { describe, expect, it, vi } from "vitest";
import {
  createReceiptExtractor,
  evaluateReceiptObservation,
  type ReceiptObservation,
} from "../src/providers/receipt-extractor.js";

const result = { schemaVersion: 1 as const, merchant: "M", amount: "1.00", currency: "USD", incurredOn: "2026-01-01", confidence: 1 };
const data = Uint8Array.from([1, 2, 3]);
const observation: ReceiptObservation = {
  merchant: "M",
  total: "10.00",
  currency: "USD",
  incurredOn: "2026-01-01",
  taxAmount: "1.00",
  confidence: 1,
};

describe("evaluateReceiptObservation", () => {
  it.each([
    ["merchant", null, ["merchant_missing"]],
    ["total", null, ["total_missing"]],
    ["total", "0.00", ["total_zero"]],
    ["currency", null, ["currency_missing"]],
    ["incurredOn", null, ["date_missing"]],
    ["taxAmount", null, ["tax_missing"]],
    ["taxAmount", "0.00", ["tax_zero_requires_confirmation"]],
  ] as const)("reports %s=%j under the Capture policy", (field, value, issues) => {
    expect(evaluateReceiptObservation(
      { ...observation, [field]: value },
      "capture_required_fields_v1",
    )).toEqual({
      schemaVersion: 1,
      outcome: "needs_input",
      fields: {
        merchant: field === "merchant" ? value : "M",
        total: field === "total" ? value : "10.00",
        currency: field === "currency" ? value : "USD",
        incurredOn: field === "incurredOn" ? value : "2026-01-01",
        taxAmount: field === "taxAmount" ? value : "1.00",
      },
      issues,
    });
  });

  it("requires positive total and tax before Capture is complete", () => {
    expect(evaluateReceiptObservation(observation, "capture_required_fields_v1")).toEqual({
      schemaVersion: 1,
      outcome: "complete",
      fields: {
        merchant: "M",
        total: "10.00",
        currency: "USD",
        incurredOn: "2026-01-01",
        taxAmount: "1.00",
      },
    });
    expect(evaluateReceiptObservation(
      { ...observation, total: "0.00", taxAmount: "0.00" },
      "capture_required_fields_v1",
    )).toMatchObject({
      outcome: "needs_input",
      issues: ["total_zero", "tax_zero_requires_confirmation"],
    });
  });

  it("keeps the default zero-total behavior unchanged", () => {
    expect(() => evaluateReceiptObservation({ ...observation, total: "0.00" }))
      .toThrowError(expect.objectContaining({ type: "OcrZeroAmount", nonRetryable: true }));
  });
});

describe("createReceiptExtractor", () => {
  it("dispatches openai routes to the OpenAI extractor with the route", async () => {
    const openai = vi.fn(async () => result);
    const fake = vi.fn(() => result);
    const route = { providerKind: "openai", providerModelId: "gpt-5.4" };
    await createReceiptExtractor({ openai, fake })(data, route);
    expect(openai).toHaveBeenCalledWith(data, route);
    expect(fake).not.toHaveBeenCalled();
  });
  it("uses the fake only for fake routes and warns", async () => {
    const warn = vi.fn();
    const fake = vi.fn(() => result);
    await createReceiptExtractor({ openai: vi.fn(), fake, warn })(data, { providerKind: "fake", providerModelId: "fake-ocr-v1" });
    expect(fake).toHaveBeenCalledWith(data);
    expect(warn).toHaveBeenCalledOnce();
  });
  it("rejects other providers non-retryably", () => {
    expect(() => createReceiptExtractor({ openai: vi.fn(), fake: vi.fn() })(data, { providerKind: "anthropic", providerModelId: "x" }))
      .toThrowError(expect.objectContaining({ nonRetryable: true, type: "OcrUnsupportedProvider" }));
  });
  it("never falls back to the fake when the OpenAI extractor fails", async () => {
    const fake = vi.fn(() => result);
    const openai = vi.fn(async () => { throw new Error("all keys failed"); });
    await expect(createReceiptExtractor({ openai, fake })(data, { providerKind: "openai", providerModelId: "m" })).rejects.toThrow("all keys failed");
    expect(fake).not.toHaveBeenCalled();
  });
});
