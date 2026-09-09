import { randomBytes, randomUUID } from "node:crypto";

import {
  FORWARDED_RECEIPT_WORKFLOW_TYPE,
  InboundWebhookRequestSchema,
  MAX_UPLOAD_BYTES,
  type FileContentType,
  type InboundEmail,
  type InboundWebhookRequest,
  type QuarantineReasonSchema,
  type RoutingToken,
  type VerifiedEmailSender,
} from "@expense-tax/contracts";
import sanitizeHtml from "sanitize-html";
import type { Kysely, Selectable } from "kysely";
import type { z } from "zod";

import type { AppDatabase } from "../database/types.js";
import type { MalwareScanner } from "../inbound/security.js";
import {
  attachmentMagicMatches,
  emailAuthAccepted,
  hmacHex,
  sha256,
} from "../inbound/security.js";
import type { VerificationNotifier } from "../inbound/notifier.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import type { FileScope, FilesDomain } from "./files.js";
import { requireScopeRole } from "./files.js";
import { toJsonValue } from "./idempotency.js";
import type { OcrJobsDomain } from "./ocr.js";
import type { PlansDomain } from "./plans.js";

type QuarantineReason = z.infer<typeof QuarantineReasonSchema>;
type SenderRow = Selectable<AppDatabase["app.verified_email_senders"]>;
type TokenRow = Selectable<AppDatabase["app.inbound_routing_tokens"]>;
type InboundRow = Selectable<AppDatabase["app.inbound_emails"]>;

export const MAX_INBOUND_ATTACHMENTS = 5;
export const MAX_INBOUND_TOTAL_BYTES = 30 * 1024 * 1024;
export const MAX_INBOUND_PER_HOUR = 30;
const CHALLENGE_TTL_MS = 30 * 60 * 1_000;
const SUPPORTED_CONTENT_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

function isFileContentType(value: string): value is FileContentType {
  return SUPPORTED_CONTENT_TYPES.has(value);
}

export interface InboundEmailConfig {
  readonly baseAddress: string;
  readonly routingTokenSecret: string;
}

export interface InboundEmailDomain {
  createSender(input: {
    actorUserId: string;
    tenantId: string;
    scope: FileScope;
    email: string;
    requestId: string;
  }): Promise<VerifiedEmailSender>;
  verifySender(input: {
    actorUserId: string;
    tenantId: string;
    scope: FileScope;
    senderId: string;
    verificationToken: string;
    requestId: string;
  }): Promise<VerifiedEmailSender>;
  revokeSender(input: {
    actorUserId: string;
    tenantId: string;
    scope: FileScope;
    senderId: string;
    requestId: string;
  }): Promise<void>;
  listSenders(input: {
    actorUserId: string;
    tenantId: string;
    scope: FileScope;
  }): Promise<readonly VerifiedEmailSender[]>;
  rotateRoutingToken(input: {
    actorUserId: string;
    tenantId: string;
    scope: FileScope;
    requestId: string;
  }): Promise<RoutingToken>;
  getRoutingToken(input: {
    actorUserId: string;
    tenantId: string;
    scope: FileScope;
  }): Promise<RoutingToken>;
  listInboundEmails(input: {
    actorUserId: string;
    tenantId: string;
    scope: FileScope;
    quarantinedOnly?: boolean;
  }): Promise<readonly InboundEmail[]>;
  dismissInboundEmail(input: {
    actorUserId: string;
    tenantId: string;
    scope: FileScope;
    inboundEmailId: string;
    requestId: string;
  }): Promise<void>;
  handleWebhook(payload: InboundWebhookRequest): Promise<{
    inboundEmail: InboundEmail;
    createdFileIds: readonly string[];
    createdJobIds: readonly string[];
  }>;
}

function scopeColumns(scope: FileScope): {
  personal_profile_id: string | null;
  business_id: string | null;
} {
  return scope.kind === "personal"
    ? { personal_profile_id: scope.profileId, business_id: null }
    : { personal_profile_id: null, business_id: scope.businessId };
}

function toSender(row: SenderRow): VerifiedEmailSender {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personalProfileId: row.personal_profile_id,
    businessId: row.business_id,
    email: row.email,
    status: row.status,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function cleanPlainText(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const cleaned = sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
  })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return cleaned || null;
}

function tokenForId(secret: string, id: string): string {
  // 32 lowercase hex chars = 128 bits; stays under RFC local-part limit
  // once prefixed with "receipts+".
  return hmacHex(secret, id).slice(0, 32);
}

function routingAddress(baseAddress: string, token: string): string {
  const at = baseAddress.lastIndexOf("@");
  if (at <= 0) throw new Error("INBOUND_EMAIL_BASE_ADDRESS must be an email address");
  return `${baseAddress.slice(0, at)}+${token}@${baseAddress.slice(at + 1)}`;
}

function tokenFromAddress(baseAddress: string, address: string): string | null {
  const at = baseAddress.lastIndexOf("@");
  if (at <= 0) return null;
  const prefix = `${baseAddress.slice(0, at).toLowerCase()}+`;
  const suffix = `@${baseAddress.slice(at + 1).toLowerCase()}`;
  const normalized = address.toLowerCase();
  if (!normalized.startsWith(prefix) || !normalized.endsWith(suffix)) return null;
  const token = normalized.slice(prefix.length, -suffix.length);
  return /^[a-f0-9]{32}$/.test(token) ? token : null;
}

function toRoutingToken(row: TokenRow, config: InboundEmailConfig): RoutingToken {
  const raw = tokenForId(config.routingTokenSecret, row.id);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personalProfileId: row.personal_profile_id,
    businessId: row.business_id,
    status: row.status,
    routingAddress: routingAddress(config.baseAddress, raw),
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

function toInbound(row: InboundRow): InboundEmail {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personalProfileId: row.personal_profile_id,
    businessId: row.business_id,
    providerMessageId: row.provider_message_id,
    senderEmail: row.sender_email,
    recipientAddress: row.recipient_address,
    subject: row.subject,
    status: row.status,
    quarantineReason: row.quarantine_reason as QuarantineReason | null,
    attachmentCount: row.attachment_count,
    totalBytes: row.total_bytes,
    createdAt: row.created_at.toISOString(),
    processedAt: row.processed_at?.toISOString() ?? null,
  };
}

function scopeMatches(row: { personal_profile_id: string | null; business_id: string | null }, scope: FileScope): boolean {
  return scope.kind === "personal"
    ? row.personal_profile_id === scope.profileId && row.business_id === null
    : row.business_id === scope.businessId && row.personal_profile_id === null;
}

export function createInboundEmailDomain(
  database: Kysely<AppDatabase>,
  deps: {
    readonly filesDomain: FilesDomain;
    readonly ocrJobsDomain: OcrJobsDomain;
    readonly plansDomain: PlansDomain;
    readonly notifier: VerificationNotifier;
    readonly malwareScanner: MalwareScanner;
    readonly config: InboundEmailConfig;
  },
): InboundEmailDomain {
  async function requireOwner(actorUserId: string, tenantId: string, scope: FileScope): Promise<void> {
    const role = await requireScopeRole(database, { actorUserId, tenantId, scope });
    if (role !== "owner") throw DomainError.forbidden();
  }

  async function quarantine(input: {
    payload: InboundWebhookRequest;
    reason: QuarantineReason;
    contentHash: string;
    token?: TokenRow | undefined;
    totalBytes: number;
  }): Promise<InboundRow> {
    const now = new Date();
    return database.transaction().execute(async (transaction) => {
      const scoped = input.token
        ? {
            tenant_id: input.token.tenant_id,
            personal_profile_id: input.token.personal_profile_id,
            business_id: input.token.business_id,
            routing_token_id: input.token.id,
          }
        : {
            tenant_id: null,
            personal_profile_id: null,
            business_id: null,
            routing_token_id: null,
          };
      const row = await transaction
        .insertInto("app.inbound_emails")
        .values({
          id: randomUUID(),
          ...scoped,
          provider_message_id: input.payload.providerMessageId,
          sender_email: input.payload.senderEmail.toLowerCase(),
          recipient_address: input.payload.recipientAddress.toLowerCase(),
          subject: cleanPlainText(input.payload.subject, 500),
          content_hash: input.contentHash,
          auth_results: toJsonValue(input.payload.auth),
          status: "QUARANTINED",
          quarantine_reason: input.reason,
          attachment_count: input.payload.attachments.length,
          total_bytes: input.totalBytes,
          created_at: now,
          processed_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.inbound_email_quarantine_events")
        .values({
          id: randomUUID(),
          inbound_email_id: row.id,
          reason: input.reason,
          actor_user_id: null,
          action: "QUARANTINED",
          created_at: now,
        })
        .execute();
      return row;
    });
  }

  return {
    async createSender(input) {
      await requireOwner(input.actorUserId, input.tenantId, input.scope);
      const id = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const now = new Date();
      const created = await database
        .insertInto("app.verified_email_senders")
        .values({
          id,
          tenant_id: input.tenantId,
          ...scopeColumns(input.scope),
          email: input.email.trim().toLowerCase(),
          status: "pending",
          challenge_hash: sha256(token),
          challenge_expires_at: new Date(now.getTime() + CHALLENGE_TTL_MS),
          verified_at: null,
          created_by_user_id: input.actorUserId,
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      try {
        await deps.notifier.send({ senderId: id, email: created.email, token });
      } catch (error: unknown) {
        // A dead notifier must not strand a non-retryable pending sender
        // behind the partial unique index. Revoke the unusable challenge;
        // caller may create a fresh one after delivery recovers.
        await database
          .updateTable("app.verified_email_senders")
          .set({
            status: "revoked",
            challenge_hash: null,
            challenge_expires_at: null,
          })
          .where("id", "=", id)
          .execute();
        throw error;
      }
      return toSender(created);
    },

    async verifySender(input) {
      await requireOwner(input.actorUserId, input.tenantId, input.scope);
      return database.transaction().execute(async (transaction) => {
        const row = await transaction
          .selectFrom("app.verified_email_senders")
          .selectAll()
          .where("id", "=", input.senderId)
          .where("tenant_id", "=", input.tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (!row || !scopeMatches(row, input.scope)) throw DomainError.notFound();
        if (row.status === "verified") return toSender(row);
        if (
          row.status !== "pending" ||
          !row.challenge_hash ||
          !row.challenge_expires_at ||
          row.challenge_expires_at.getTime() < Date.now() ||
          sha256(input.verificationToken) !== row.challenge_hash
        ) {
          throw DomainError.forbidden();
        }
        const now = new Date();
        const updated = await transaction
          .updateTable("app.verified_email_senders")
          .set({
            status: "verified",
            challenge_hash: null,
            challenge_expires_at: null,
            verified_at: now,
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "verified_email_sender.verified",
          outcome: "success",
          resourceType: "verified_email_sender",
          resourceId: row.id,
          requestId: input.requestId,
        });
        return toSender(updated);
      });
    },

    async revokeSender(input) {
      await requireOwner(input.actorUserId, input.tenantId, input.scope);
      await database.transaction().execute(async (transaction) => {
        const row = await transaction
          .selectFrom("app.verified_email_senders")
          .selectAll()
          .where("id", "=", input.senderId)
          .where("tenant_id", "=", input.tenantId)
          .executeTakeFirst();
        if (!row || !scopeMatches(row, input.scope)) throw DomainError.notFound();
        await transaction
          .updateTable("app.verified_email_senders")
          .set({
            status: "revoked",
            challenge_hash: null,
            challenge_expires_at: null,
          })
          .where("id", "=", row.id)
          .execute();
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "verified_email_sender.revoked",
          outcome: "success",
          resourceType: "verified_email_sender",
          resourceId: row.id,
          requestId: input.requestId,
        });
      });
    },

    async listSenders(input) {
      await requireScopeRole(database, input);
      let query = database
        .selectFrom("app.verified_email_senders")
        .selectAll()
        .where("tenant_id", "=", input.tenantId);
      query =
        input.scope.kind === "personal"
          ? query.where("personal_profile_id", "=", input.scope.profileId)
          : query.where("business_id", "=", input.scope.businessId);
      return (await query.orderBy("created_at", "desc").execute()).map(toSender);
    },

    async rotateRoutingToken(input) {
      await requireOwner(input.actorUserId, input.tenantId, input.scope);
      const verified = await database
        .selectFrom("app.verified_email_senders")
        .select("id")
        .where("tenant_id", "=", input.tenantId)
        .where("status", "=", "verified")
        .$if(input.scope.kind === "personal", (query) =>
          query.where("personal_profile_id", "=", input.scope.kind === "personal" ? input.scope.profileId : ""),
        )
        .$if(input.scope.kind === "business", (query) =>
          query.where("business_id", "=", input.scope.kind === "business" ? input.scope.businessId : ""),
        )
        .executeTakeFirst();
      if (!verified) throw DomainError.conflict();

      return database.transaction().execute(async (transaction) => {
        const now = new Date();
        let active = transaction
          .updateTable("app.inbound_routing_tokens")
          .set({ status: "revoked", revoked_at: now })
          .where("tenant_id", "=", input.tenantId)
          .where("status", "=", "active");
        active =
          input.scope.kind === "personal"
            ? active.where("personal_profile_id", "=", input.scope.profileId)
            : active.where("business_id", "=", input.scope.businessId);
        await active.execute();

        const id = randomUUID();
        const raw = tokenForId(deps.config.routingTokenSecret, id);
        const created = await transaction
          .insertInto("app.inbound_routing_tokens")
          .values({
            id,
            tenant_id: input.tenantId,
            ...scopeColumns(input.scope),
            token_hash: sha256(raw),
            status: "active",
            created_by_user_id: input.actorUserId,
            created_at: now,
            revoked_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "inbound_routing_token.rotated",
          outcome: "success",
          resourceType: "inbound_routing_token",
          resourceId: id,
          requestId: input.requestId,
        });
        return toRoutingToken(created, deps.config);
      });
    },

    async getRoutingToken(input) {
      await requireScopeRole(database, input);
      let query = database
        .selectFrom("app.inbound_routing_tokens")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("status", "=", "active");
      query =
        input.scope.kind === "personal"
          ? query.where("personal_profile_id", "=", input.scope.profileId)
          : query.where("business_id", "=", input.scope.businessId);
      const row = await query.executeTakeFirst();
      if (!row) throw DomainError.notFound();
      return toRoutingToken(row, deps.config);
    },

    async listInboundEmails(input) {
      await requireScopeRole(database, input);
      let query = database
        .selectFrom("app.inbound_emails")
        .selectAll()
        .where("tenant_id", "=", input.tenantId);
      query =
        input.scope.kind === "personal"
          ? query.where("personal_profile_id", "=", input.scope.profileId)
          : query.where("business_id", "=", input.scope.businessId);
      if (input.quarantinedOnly) query = query.where("status", "=", "QUARANTINED");
      return (await query.orderBy("created_at", "desc").limit(100).execute()).map(toInbound);
    },

    async dismissInboundEmail(input) {
      const role = await requireScopeRole(database, input);
      if (role === "viewer") throw DomainError.forbidden();
      await database.transaction().execute(async (transaction) => {
        const row = await transaction
          .selectFrom("app.inbound_emails")
          .selectAll()
          .where("id", "=", input.inboundEmailId)
          .where("tenant_id", "=", input.tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (!row || !scopeMatches(row, input.scope)) throw DomainError.notFound();
        if (row.status !== "QUARANTINED") throw DomainError.conflict();
        await transaction
          .updateTable("app.inbound_emails")
          .set({ status: "DISMISSED" })
          .where("id", "=", row.id)
          .execute();
        await transaction
          .insertInto("app.inbound_email_quarantine_events")
          .values({
            id: randomUUID(),
            inbound_email_id: row.id,
            reason: row.quarantine_reason ?? "DISMISSED",
            actor_user_id: input.actorUserId,
            action: "DISMISSED",
            created_at: new Date(),
          })
          .execute();
      });
    },

    async handleWebhook(rawPayload) {
      const payload = InboundWebhookRequestSchema.parse(rawPayload);
      const attachments = payload.attachments.map((attachment) => ({
        ...attachment,
        bytes: Buffer.from(attachment.dataBase64, "base64"),
      }));
      const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.bytes.length, 0);
      const cleanSubject = cleanPlainText(payload.subject, 500) ?? "";
      const cleanText = cleanPlainText(payload.textBody, 100_000) ?? "";
      const cleanHtml = cleanPlainText(payload.htmlBody, 100_000) ?? "";
      const contentHash = sha256(
        [
          payload.senderEmail.toLowerCase(),
          payload.recipientAddress.toLowerCase(),
          cleanSubject,
          cleanText,
          cleanHtml,
          ...attachments.map((attachment) => sha256(attachment.bytes)),
        ].join("\n"),
      );

      const existing = await database
        .selectFrom("app.inbound_emails")
        .selectAll()
        .where("provider_message_id", "=", payload.providerMessageId)
        .executeTakeFirst();
      if (existing) {
        if (existing.content_hash !== contentHash) throw DomainError.conflict();
        return { inboundEmail: toInbound(existing), createdFileIds: [], createdJobIds: [] };
      }

      const rawToken = tokenFromAddress(deps.config.baseAddress, payload.recipientAddress);
      const token = rawToken
        ? await database
            .selectFrom("app.inbound_routing_tokens")
            .selectAll()
            .where("token_hash", "=", sha256(rawToken))
            .executeTakeFirst()
        : undefined;
      const quarantineNow = async (reason: QuarantineReason) => ({
        inboundEmail: toInbound(
          await quarantine({ payload, reason, contentHash, token, totalBytes }),
        ),
        createdFileIds: [] as string[],
        createdJobIds: [] as string[],
      });

      if (!rawToken || !token) return quarantineNow("UNKNOWN_TOKEN");
      if (token.status !== "active") return quarantineNow("TOKEN_REVOKED");
      if (!emailAuthAccepted(payload.auth)) return quarantineNow("EMAIL_AUTH_FAILED");
      if (attachments.length === 0) return quarantineNow("NO_ATTACHMENTS");
      if (attachments.length > MAX_INBOUND_ATTACHMENTS) return quarantineNow("TOO_MANY_ATTACHMENTS");
      if (
        totalBytes > MAX_INBOUND_TOTAL_BYTES ||
        attachments.some((attachment) => attachment.bytes.length > MAX_UPLOAD_BYTES)
      ) {
        return quarantineNow("MESSAGE_TOO_LARGE");
      }

      let senderQuery = database
        .selectFrom("app.verified_email_senders")
        .selectAll()
        .where("tenant_id", "=", token.tenant_id)
        .where("email", "=", payload.senderEmail.toLowerCase())
        .where("status", "=", "verified");
      senderQuery = token.personal_profile_id
        ? senderQuery.where("personal_profile_id", "=", token.personal_profile_id)
        : senderQuery.where("business_id", "=", token.business_id as string);
      const sender = await senderQuery.executeTakeFirst();
      if (!sender) {
        let anyVerifiedQuery = database
          .selectFrom("app.verified_email_senders")
          .select("id")
          .where("tenant_id", "=", token.tenant_id)
          .where("status", "=", "verified");
        anyVerifiedQuery = token.personal_profile_id
          ? anyVerifiedQuery.where(
              "personal_profile_id",
              "=",
              token.personal_profile_id,
            )
          : anyVerifiedQuery.where("business_id", "=", token.business_id as string);
        const anyVerified = await anyVerifiedQuery.executeTakeFirst();
        return quarantineNow(anyVerified ? "SENDER_MISMATCH" : "SENDER_NOT_VERIFIED");
      }
      if (!scopeMatches(sender, token.personal_profile_id
        ? { kind: "personal", profileId: token.personal_profile_id }
        : { kind: "business", businessId: token.business_id as string })) {
        return quarantineNow("SENDER_MISMATCH");
      }

      const recentCount = await database
        .selectFrom("app.inbound_emails")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("routing_token_id", "=", token.id)
        .where("created_at", ">", new Date(Date.now() - 60 * 60 * 1_000))
        .executeTakeFirstOrThrow();
      if (Number(recentCount.count) >= MAX_INBOUND_PER_HOUR) return quarantineNow("RATE_LIMITED");

      const duplicate = await database
        .selectFrom("app.inbound_emails")
        .select("id")
        .where("tenant_id", "=", token.tenant_id)
        .where("content_hash", "=", contentHash)
        .where("status", "=", "ACCEPTED")
        .executeTakeFirst();
      if (duplicate) return quarantineNow("DUPLICATE");

      const entitlements = await deps.plansDomain.resolveEffectiveEntitlements({
        tenantId: token.tenant_id,
        actorUserId: sender.created_by_user_id,
      });
      if (!entitlements.find((item) => item.featureKey === "receipt_forwarding")?.isEnabled) {
        return quarantineNow("ENTITLEMENT_DISABLED");
      }

      for (const attachment of attachments) {
        if (!isFileContentType(attachment.contentType)) {
          return quarantineNow("UNSUPPORTED_ATTACHMENT");
        }
        if (!attachmentMagicMatches(attachment.contentType, attachment.bytes)) {
          return quarantineNow("INVALID_ATTACHMENT");
        }
        const scan = await deps.malwareScanner.scan(attachment.bytes);
        if (!scan.clean) return quarantineNow("MALWARE_DETECTED");
      }

      const scope: FileScope = token.personal_profile_id
        ? { kind: "personal", profileId: token.personal_profile_id }
        : { kind: "business", businessId: token.business_id as string };
      const now = new Date();
      const inbound = await database
        .insertInto("app.inbound_emails")
        .values({
          id: randomUUID(),
          tenant_id: token.tenant_id,
          ...scopeColumns(scope),
          routing_token_id: token.id,
          provider_message_id: payload.providerMessageId,
          sender_email: payload.senderEmail.toLowerCase(),
          recipient_address: payload.recipientAddress.toLowerCase(),
          subject: cleanSubject || null,
          content_hash: contentHash,
          auth_results: toJsonValue(payload.auth),
          status: "ACCEPTED",
          quarantine_reason: null,
          attachment_count: attachments.length,
          total_bytes: totalBytes,
          created_at: now,
          processed_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const createdFileIds: string[] = [];
      const createdJobIds: string[] = [];
      try {
        for (const [index, attachment] of attachments.entries()) {
          if (!isFileContentType(attachment.contentType)) {
            // Defensive backstop: trust validation above already returned.
            throw DomainError.validation();
          }
          const attachmentId = randomUUID();
          await database
            .insertInto("app.inbound_email_attachments")
            .values({
              id: attachmentId,
              inbound_email_id: inbound.id,
              expense_file_id: null,
              original_filename: attachment.filename,
              content_type: attachment.contentType,
              size_bytes: attachment.bytes.length,
              sha256_hex: sha256(attachment.bytes),
              created_at: now,
            })
            .execute();
          const session = await deps.filesDomain.createUploadSession({
            actorUserId: sender.created_by_user_id,
            tenantId: token.tenant_id,
            scope,
            request: {
              originalFilename: attachment.filename,
              contentType: attachment.contentType,
              expectedSizeBytes: attachment.bytes.length,
            },
            idempotencyKey: `inbound:${payload.providerMessageId}:${index}:file`,
            requestId: `inbound-${inbound.id}-${index}-file`,
          });
          await deps.filesDomain.writePendingContent({
            fileId: session.body.file.id,
            data: attachment.bytes,
            contentType: attachment.contentType,
          });
          const file = await deps.filesDomain.confirmUploadSession({
            actorUserId: sender.created_by_user_id,
            tenantId: token.tenant_id,
            scope,
            sessionId: session.body.uploadSession.id,
            requestId: `inbound-${inbound.id}-${index}-confirm`,
          });
          createdFileIds.push(file.id);
          await database
            .updateTable("app.inbound_email_attachments")
            .set({ expense_file_id: file.id })
            .where("id", "=", attachmentId)
            .execute();
          const job = await deps.ocrJobsDomain.createOcrJob({
            actorUserId: sender.created_by_user_id,
            tenantId: token.tenant_id,
            scope,
            fileId: file.id,
            modeKey: "ocr_mode_fast",
            idempotencyKey: `inbound:${payload.providerMessageId}:${index}:ocr`,
            requestId: `inbound-${inbound.id}-${index}-ocr`,
            workflowType: FORWARDED_RECEIPT_WORKFLOW_TYPE,
            extraInputParams: { inboundEmailId: inbound.id },
          });
          createdJobIds.push(job.body.id);
        }
        const processedAt = new Date();
        const updated = await database
          .updateTable("app.inbound_emails")
          .set({ processed_at: processedAt })
          .where("id", "=", inbound.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          inboundEmail: toInbound(updated),
          createdFileIds,
          createdJobIds,
        };
      } catch {
        const failedAt = new Date();
        await database.transaction().execute(async (transaction) => {
          await transaction
            .updateTable("app.inbound_emails")
            .set({
              status: "QUARANTINED",
              quarantine_reason: "PROCESSING_FAILED",
              processed_at: failedAt,
            })
            .where("id", "=", inbound.id)
            .execute();
          await transaction
            .insertInto("app.inbound_email_quarantine_events")
            .values({
              id: randomUUID(),
              inbound_email_id: inbound.id,
              reason: "PROCESSING_FAILED",
              actor_user_id: null,
              action: "QUARANTINED",
              created_at: failedAt,
            })
            .execute();
          for (const jobId of createdJobIds) {
            await transaction
              .updateTable("app.processing_job_dispatch_outbox")
              .set({ status: "FAILED", last_error: "inbound processing failed" })
              .where("processing_job_id", "=", jobId)
              .execute();
            await transaction
              .updateTable("app.processing_jobs")
              .set((eb) => ({
                status: "FAILED",
                error_message: "INBOUND_PROCESSING_FAILED",
                dispatched_at: failedAt,
                completed_at: failedAt,
                updated_at: failedAt,
                version: eb("version", "+", 1),
              }))
              .where("id", "=", jobId)
              .where("status", "=", "PENDING")
              .execute();
          }
        });
        const failed = await database
          .selectFrom("app.inbound_emails")
          .selectAll()
          .where("id", "=", inbound.id)
          .executeTakeFirstOrThrow();
        return { inboundEmail: toInbound(failed), createdFileIds, createdJobIds: [] };
      }
    },
  };
}
