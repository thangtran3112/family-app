import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface ClerkWebhookHeaders {
  readonly "svix-id": string;
  readonly "svix-timestamp": string;
  readonly "svix-signature": string;
}

export type ClerkWebhookEventType =
  | "user.created"
  | "user.updated"
  | "user.deleted"
  | "organization.created"
  | "organization.updated"
  | "organization.deleted"
  | "organizationMembership.created"
  | "organizationMembership.updated"
  | "organizationMembership.deleted";

export interface ClerkWebhookEvent {
  readonly id: string;
  readonly type: ClerkWebhookEventType;
  readonly data: Record<string, unknown>;
}

export class ClerkWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClerkWebhookPayloadError";
  }
}

function signingKey(secret: string): Buffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return Buffer.from(encoded, "base64");
}

export function verifyClerkWebhookSignature(
  secret: string,
  rawBody: Buffer,
  headers: ClerkWebhookHeaders,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
): boolean {
  if (!secret || !headers["svix-id"] || headers["svix-id"].length > 255 || !headers["svix-timestamp"]) return false;
  const timestamp = Number(headers["svix-timestamp"]);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const prefix = Buffer.from(`${headers["svix-id"]}.${headers["svix-timestamp"]}.`, "utf8");
  const expected = createHmac("sha256", signingKey(secret)).update(Buffer.concat([prefix, rawBody])).digest("base64");
  return headers["svix-signature"].split(" ").some((signature) => {
    const [version, value] = signature.split(",", 2);
    if (version !== "v1" || value === undefined) return false;
    const actual = Buffer.from(value, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
  });
}

const EVENT_TYPES = new Set<ClerkWebhookEventType>([
  "user.created",
  "user.updated",
  "user.deleted",
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organizationMembership.created",
  "organizationMembership.updated",
  "organizationMembership.deleted",
]);

export function parseClerkWebhookEvent(id: string, type: string, data: unknown): ClerkWebhookEvent {
  if (!id || id.length > 255 || !EVENT_TYPES.has(type as ClerkWebhookEventType)) throw new ClerkWebhookPayloadError("Unsupported Clerk webhook event");
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new ClerkWebhookPayloadError("Malformed Clerk webhook data");
  return { id, type: type as ClerkWebhookEventType, data: data as Record<string, unknown> };
}
