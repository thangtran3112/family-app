import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DecimalMoneySchema,
  ErrorResponseSchema,
  ExpenseSchema,
  HealthResponseSchema,
  HealthStatusSchema,
  JobReferenceV1Schema,
  NonNegativeMoneySchema,
  ServiceNameSchema,
  type ErrorResponse,
  type HealthResponse,
  type HealthStatus,
  type JobReferenceV1,
  type ServiceName,
} from "../src/index.js";

const jobReferenceFixture: unknown = JSON.parse(
  readFileSync(
    new URL("../fixtures/job-reference-v1.json", import.meta.url),
    "utf8",
  ),
);

describe("system contracts", () => {
  it("accepts only supported service names and health statuses", () => {
    expect(ServiceNameSchema.parse("app-api")).toBe("app-api");
    expect(ServiceNameSchema.parse("foundry-service")).toBe("foundry-service");
    expect(HealthStatusSchema.parse("ok")).toBe("ok");
    expect(HealthStatusSchema.parse("degraded")).toBe("degraded");
    expect(ServiceNameSchema.safeParse("expense-service").success).toBe(false);
    expect(HealthStatusSchema.safeParse("healthy").success).toBe(false);
  });

  it("validates a strict health response", () => {
    expect(
      HealthResponseSchema.parse({
        status: "ok",
        service: "app-api",
        version: "0.1.0",
      }),
    ).toEqual({
      status: "ok",
      service: "app-api",
      version: "0.1.0",
    });
    expect(
      HealthResponseSchema.safeParse({
        status: "ok",
        service: "app-api",
        version: "0.1.0",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("error contract", () => {
  it("validates a strict error envelope", () => {
    expect(
      ErrorResponseSchema.parse({
        error: {
          code: "not_found",
          message: "Resource not found",
          requestId: "request-123",
        },
      }),
    ).toEqual({
      error: {
        code: "not_found",
        message: "Resource not found",
        requestId: "request-123",
      },
    });
    expect(
      ErrorResponseSchema.safeParse({
        error: {
          code: "not_found",
          message: "Resource not found",
          requestId: "request-123",
          details: {},
        },
      }).success,
    ).toBe(false);
  });
});

describe("money contracts", () => {
  it("keeps positive expense money strict and adds non-negative response money", () => {
    expect(DecimalMoneySchema.safeParse("0.00").success).toBe(false);

    for (const value of ["0", "0.00", "12.34"]) {
      expect(NonNegativeMoneySchema.parse(value)).toBe(value);
    }
    for (const value of ["-1.00", "1.234", "01.00"]) {
      expect(NonNegativeMoneySchema.safeParse(value).success).toBe(false);
    }
  });

  it.each(["1.23", "0.00", null])(
    "accepts expense response tax amount %s",
    (taxAmount) => {
      expect(
        ExpenseSchema.parse({
          id: "11111111-1111-4111-8111-111111111111",
          tenantId: "22222222-2222-4222-8222-222222222222",
          createdByUserId: "33333333-3333-4333-8333-333333333333",
          personalProfileId: "44444444-4444-4444-8444-444444444444",
          businessId: null,
          projectId: null,
          spendingCategoryId: null,
          merchant: "Market",
          description: null,
          amount: "12.34",
          taxAmount,
          currency: "USD",
          incurredOn: "2026-10-17",
          taxYear: 2026,
          source: "manual",
          mailboxProvenance: null,
          status: "ready",
          version: 1,
          createdAt: "2026-10-17T12:00:00.000Z",
          updatedAt: "2026-10-17T12:00:00.000Z",
        }).taxAmount,
      ).toBe(taxAmount);
    },
  );
});

describe("job reference contract", () => {
  it("accepts the canonical v1 fixture", () => {
    expect(JobReferenceV1Schema.parse(jobReferenceFixture)).toEqual(
      jobReferenceFixture,
    );
  });

  it("rejects extra keys, malformed UUIDs, and empty workflow identifiers", () => {
    expect(
      JobReferenceV1Schema.safeParse({
        ...(jobReferenceFixture as Record<string, unknown>),
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      JobReferenceV1Schema.safeParse({
        ...(jobReferenceFixture as Record<string, unknown>),
        jobId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      JobReferenceV1Schema.safeParse({
        ...(jobReferenceFixture as Record<string, unknown>),
        workflowType: "",
      }).success,
    ).toBe(false);
    expect(
      JobReferenceV1Schema.safeParse({
        ...(jobReferenceFixture as Record<string, unknown>),
        workflowId: "",
      }).success,
    ).toBe(false);
  });
});

describe("inferred types", () => {
  it("match the transport primitives", () => {
    expectTypeOf<ServiceName>().toEqualTypeOf<
      "app-api" | "foundry-service"
    >();
    expectTypeOf<HealthStatus>().toEqualTypeOf<"ok" | "degraded">();
    expectTypeOf<HealthResponse>().toEqualTypeOf<{
      status: "ok" | "degraded";
      service: "app-api" | "foundry-service";
      version: string;
    }>();
    expectTypeOf<ErrorResponse>().toEqualTypeOf<{
      error: {
        code: string;
        message: string;
        requestId: string;
      };
    }>();
    expectTypeOf<JobReferenceV1>().toEqualTypeOf<{
      schemaVersion: 1;
      jobId: string;
      workflowType:
        | "FoundationEchoWorkflow"
        | "OcrReceiptWorkflow"
        | "ForwardedReceiptWorkflow"
        | "ExpenseEnrichmentWorkflow"
        | "MailboxScanWorkflow"
        | "MailboxOcrReceiptWorkflow"
        | "MailboxMaterializeWorkflow";
      workflowId: string;
    }>();
  });
});
