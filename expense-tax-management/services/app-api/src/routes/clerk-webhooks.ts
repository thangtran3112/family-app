import { Readable } from "node:stream";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { DomainError } from "../errors.js";
import type { ClerkWebhookHandler } from "../integrations/clerk-webhooks.js";
import { parseClerkEventFromBody } from "../integrations/clerk-webhooks.js";
import { ClerkWebhookPayloadError, verifyClerkWebhookSignature, type ClerkWebhookHeaders } from "../integrations/clerk-webhook-signature.js";

export const CLERK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

function payloadTooLargeError(): Error & { statusCode: 413 } {
  return Object.assign(new Error("Request payload too large"), { statusCode: 413 as const });
}

function abortClerkWebhookPayload(payload: Readable): void {
  try {
    payload.destroy();
  } catch {
    // Preserve 413 even if stream cleanup fails.
  }
}

export async function readClerkWebhookBody(payload: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > CLERK_WEBHOOK_MAX_BODY_BYTES) throw payloadTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

declare module "fastify" {
  interface FastifyRequest {
    clerkRawBody?: Buffer;
  }
}

export interface ClerkWebhookRouteOptions {
  readonly signingSecret: string | undefined;
  readonly handler: ClerkWebhookHandler;
  readonly verifySignature?: (secret: string, body: Buffer, headers: ClerkWebhookHeaders) => boolean;
}

export async function registerClerkWebhookRoutes(app: FastifyInstance, options: ClerkWebhookRouteOptions): Promise<void> {
  app.post("/api/v1/integrations/clerk/webhook", {
    preParsing: async (request, _reply, payload) => {
      const contentLength = Number(request.headers["content-length"]);
      if (Number.isInteger(contentLength) && contentLength > CLERK_WEBHOOK_MAX_BODY_BYTES) {
        abortClerkWebhookPayload(payload);
        throw payloadTooLargeError();
      }
      const body = await readClerkWebhookBody(payload);
      request.clerkRawBody = body;
      return Readable.from([body]);
    },
    schema: {
      headers: z.object({ "svix-id": z.string().min(1).max(255), "svix-timestamp": z.string().min(1), "svix-signature": z.string().min(1) }),
      response: { 202: z.object({ accepted: z.literal(true), replayed: z.boolean() }) },
    },
  }, async (request, reply) => {
    const body = request.clerkRawBody;
    if (!body || !options.signingSecret) throw DomainError.unauthenticated();
    const headers = request.headers as unknown as ClerkWebhookHeaders;
    const verifier = options.verifySignature ?? verifyClerkWebhookSignature;
    if (!verifier(options.signingSecret, body, headers)) throw DomainError.unauthenticated();

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw DomainError.validation();
    }
    let event;
    try {
      event = parseClerkEventFromBody(headers["svix-id"], payload);
    } catch {
      throw DomainError.validation();
    }
    let result;
    try {
      result = await options.handler.handle(event);
    } catch (error: unknown) {
      if (error instanceof ClerkWebhookPayloadError) throw DomainError.validation();
      throw error;
    }
    return reply.code(202).send({ accepted: true, replayed: result.replayed });
  });
}
