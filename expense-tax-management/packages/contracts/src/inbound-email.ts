import { z } from "zod";

import { TimestampSchema } from "./expenses.js";

export const SenderStatusSchema = z.enum(["pending", "verified", "revoked"]);
export const InboundEmailStatusSchema = z.enum([
  "ACCEPTED",
  "QUARANTINED",
  "DISMISSED",
]);
export const EmailAuthResultSchema = z.enum(["pass", "fail", "neutral", "none"]);
export const QuarantineReasonSchema = z.enum([
  "UNKNOWN_TOKEN",
  "TOKEN_REVOKED",
  "SENDER_NOT_VERIFIED",
  "SENDER_MISMATCH",
  "EMAIL_AUTH_FAILED",
  "NO_ATTACHMENTS",
  "TOO_MANY_ATTACHMENTS",
  "MESSAGE_TOO_LARGE",
  "UNSUPPORTED_ATTACHMENT",
  "INVALID_ATTACHMENT",
  "MALWARE_DETECTED",
  "RATE_LIMITED",
  "DUPLICATE",
  "ENTITLEMENT_DISABLED",
  "PROCESSING_FAILED",
]);

export const VerifiedEmailSenderSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  personalProfileId: z.uuid().nullable(),
  businessId: z.uuid().nullable(),
  email: z.email(),
  status: SenderStatusSchema,
  verifiedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type VerifiedEmailSender = z.infer<typeof VerifiedEmailSenderSchema>;

export const CreateVerifiedSenderRequestSchema = z.strictObject({
  email: z.email().max(320),
});
export const VerifySenderRequestSchema = z.strictObject({
  verificationToken: z.string().min(32).max(200),
});
export const SenderParamsSchema = z.strictObject({ senderId: z.uuid() });

export const RoutingTokenSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  personalProfileId: z.uuid().nullable(),
  businessId: z.uuid().nullable(),
  status: z.enum(["active", "revoked"]),
  routingAddress: z.email(),
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
});
export type RoutingToken = z.infer<typeof RoutingTokenSchema>;

export const InboundAttachmentWebhookSchema = z.strictObject({
  filename: z.string().min(1).max(255),
  // Provider payload accepts arbitrary MIME here so a validly signed
  // unsupported attachment can be QUARANTINED (not rejected as malformed
  // JSON before an audit row exists). Domain narrows to FileContentType.
  contentType: z.string().min(1).max(200),
  dataBase64: z.base64(),
});

export const InboundWebhookRequestSchema = z.strictObject({
  providerMessageId: z.string().min(1).max(500),
  recipientAddress: z.email().max(320),
  senderEmail: z.email().max(320),
  subject: z.string().max(500).optional(),
  textBody: z.string().max(100_000).optional(),
  htmlBody: z.string().max(100_000).optional(),
  receivedAt: TimestampSchema,
  auth: z.strictObject({
    spf: EmailAuthResultSchema,
    dkim: EmailAuthResultSchema,
    dmarc: EmailAuthResultSchema,
    arc: EmailAuthResultSchema,
  }),
  attachments: z.array(InboundAttachmentWebhookSchema).max(20),
});
export type InboundWebhookRequest = z.infer<typeof InboundWebhookRequestSchema>;

export const InboundEmailSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid().nullable(),
  personalProfileId: z.uuid().nullable(),
  businessId: z.uuid().nullable(),
  providerMessageId: z.string(),
  senderEmail: z.string(),
  recipientAddress: z.string(),
  subject: z.string().nullable(),
  status: InboundEmailStatusSchema,
  quarantineReason: QuarantineReasonSchema.nullable(),
  attachmentCount: z.int().nonnegative(),
  totalBytes: z.int().nonnegative(),
  createdAt: TimestampSchema,
  processedAt: TimestampSchema.nullable(),
});
export type InboundEmail = z.infer<typeof InboundEmailSchema>;

export const InboundEmailListSchema = z.strictObject({
  items: z.array(InboundEmailSchema),
});
export const VerifiedSenderListSchema = z.strictObject({
  items: z.array(VerifiedEmailSenderSchema),
});
export const InboundEmailParamsSchema = z.strictObject({ inboundEmailId: z.uuid() });

export const PersonalInboundCollectionParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  profileId: z.uuid(),
});
export const BusinessInboundCollectionParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
});
export const PersonalSenderParamsSchema = PersonalInboundCollectionParamsSchema.extend({
  senderId: z.uuid(),
});
export const BusinessSenderParamsSchema = BusinessInboundCollectionParamsSchema.extend({
  senderId: z.uuid(),
});
export const PersonalInboundEmailParamsSchema =
  PersonalInboundCollectionParamsSchema.extend({ inboundEmailId: z.uuid() });
export const BusinessInboundEmailParamsSchema =
  BusinessInboundCollectionParamsSchema.extend({ inboundEmailId: z.uuid() });

export const InboundWebhookResponseSchema = z.strictObject({
  inboundEmail: InboundEmailSchema,
  createdFileIds: z.array(z.uuid()),
  createdJobIds: z.array(z.uuid()),
});
