import { describe, expect, it } from "vitest";

import {
  InboundWebhookRequestSchema,
  QuarantineReasonSchema,
  RoutingTokenSchema,
} from "../src/index.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("Phase 0P inbound-email contracts", () => {
  it("requires strict provider auth results and base64 attachments", () => {
    const parsed = InboundWebhookRequestSchema.parse({
      providerMessageId: "provider-1",
      recipientAddress: "receipts+abc@example.test",
      senderEmail: "owner@example.test",
      receivedAt: "2026-09-09T00:00:00.000Z",
      auth: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
      attachments: [
        {
          filename: "receipt.pdf",
          contentType: "application/pdf",
          dataBase64: Buffer.from("%PDF-1.4").toString("base64"),
        },
      ],
    });
    expect(parsed.attachments).toHaveLength(1);
    expect(() =>
      InboundWebhookRequestSchema.parse({
        ...parsed,
        attachments: [{ ...parsed.attachments[0], dataBase64: "not base64***" }],
      }),
    ).toThrow();
  });

  it("keeps quarantine reasons closed and explicit", () => {
    expect(QuarantineReasonSchema.options).toContain("MALWARE_DETECTED");
    expect(QuarantineReasonSchema.options).toContain("DUPLICATE");
    expect(() => QuarantineReasonSchema.parse("MAYBE_BAD")).toThrow();
  });

  it("accepts an unsupported MIME as a provider fact so domain can quarantine it", () => {
    const parsed = InboundWebhookRequestSchema.parse({
      providerMessageId: "provider-unsupported",
      recipientAddress: "receipts+abc@example.test",
      senderEmail: "owner@example.test",
      receivedAt: "2026-09-09T00:00:00.000Z",
      auth: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
      attachments: [{
        filename: "receipt.exe",
        contentType: "application/x-msdownload",
        dataBase64: Buffer.from("MZ").toString("base64"),
      }],
    });
    expect(parsed.attachments[0]?.contentType).toBe("application/x-msdownload");
  });

  it("never exposes a raw routing token field", () => {
    const route = RoutingTokenSchema.parse({
      id: ID,
      tenantId: ID,
      personalProfileId: ID,
      businessId: null,
      status: "active",
      routingAddress: "receipts+abc@example.test",
      createdAt: "2026-09-09T00:00:00.000Z",
      revokedAt: null,
    });
    expect("rawToken" in route).toBe(false);
    expect("tokenHash" in route).toBe(false);
  });
});
