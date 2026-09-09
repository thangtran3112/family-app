import {
  BusinessInboundCollectionParamsSchema,
  BusinessInboundEmailParamsSchema,
  BusinessSenderParamsSchema,
  CreateVerifiedSenderRequestSchema,
  ErrorResponseSchema,
  InboundEmailListSchema,
  InboundWebhookRequestSchema,
  InboundWebhookResponseSchema,
  PersonalInboundCollectionParamsSchema,
  PersonalInboundEmailParamsSchema,
  PersonalSenderParamsSchema,
  RoutingTokenSchema,
  VerifiedEmailSenderSchema,
  VerifiedSenderListSchema,
  VerifySenderRequestSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { FileScope } from "../domain/files.js";
import type { InboundEmailDomain } from "../domain/inbound-email.js";
import { DomainError } from "../errors.js";
import { verifyWebhookSignature } from "../inbound/security.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface InboundEmailRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly inboundEmailDomain: InboundEmailDomain;
  readonly webhookSigningKey: string;
}

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  500: ErrorResponseSchema,
};

function actorUserId(request: FastifyRequest): string {
  if (!request.authenticatedUser) throw DomainError.unauthenticated();
  return request.authenticatedUser.id;
}

function scopeFrom(params: { profileId?: string; businessId?: string }): FileScope {
  if (params.profileId) return { kind: "personal", profileId: params.profileId };
  if (params.businessId) return { kind: "business", businessId: params.businessId };
  throw DomainError.validation();
}

export async function registerInboundEmailRoutes(
  app: FastifyInstance,
  options: InboundEmailRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authentication = [
    tenantGuard,
    authenticatedUserGuard(options.identityResolver),
  ];

  // Provider signature covers the exact bytes. Custom content type avoids
  // globally replacing Fastify's JSON parser (all normal API routes retain
  // ordinary Zod validation).
  typedApp.addContentTypeParser(
    "application/vnd.expense-tax.inbound+json",
    { parseAs: "buffer", bodyLimit: 45 * 1024 * 1024 },
    async (_request: FastifyRequest, body: unknown) => body,
  );

  const scopes = [
    {
      base: "/api/v1/tenants/:tenantId/personal-profiles/:profileId/forwarding",
      collectionParams: PersonalInboundCollectionParamsSchema,
      senderParams: PersonalSenderParamsSchema,
      emailParams: PersonalInboundEmailParamsSchema,
    },
    {
      base: "/api/v1/tenants/:tenantId/businesses/:businessId/forwarding",
      collectionParams: BusinessInboundCollectionParamsSchema,
      senderParams: BusinessSenderParamsSchema,
      emailParams: BusinessInboundEmailParamsSchema,
    },
  ] as const;

  for (const route of scopes) {
    typedApp.post(
      `${route.base}/verified-senders`,
      {
        preHandler: authentication,
        schema: {
          params: route.collectionParams,
          body: CreateVerifiedSenderRequestSchema,
          security: [{ tenantBearer: [] }],
          response: { 201: VerifiedEmailSenderSchema, ...errors },
        },
      },
      async (request, reply) => {
        const params = request.params as unknown as {
          tenantId: string;
          profileId?: string;
          businessId?: string;
        };
        return reply.code(201).send(
          await options.inboundEmailDomain.createSender({
            actorUserId: actorUserId(request),
            tenantId: params.tenantId,
            scope: scopeFrom(params),
            email: request.body.email,
            requestId: request.id,
          }),
        );
      },
    );

    typedApp.get(
      `${route.base}/verified-senders`,
      {
        preHandler: authentication,
        schema: {
          params: route.collectionParams,
          security: [{ tenantBearer: [] }],
          response: { 200: VerifiedSenderListSchema, ...errors },
        },
      },
      async (request) => {
        const params = request.params as unknown as {
          tenantId: string;
          profileId?: string;
          businessId?: string;
        };
        return {
          items: [
            ...(await options.inboundEmailDomain.listSenders({
              actorUserId: actorUserId(request),
              tenantId: params.tenantId,
              scope: scopeFrom(params),
            })),
          ],
        };
      },
    );

    typedApp.post(
      `${route.base}/verified-senders/:senderId/verify`,
      {
        preHandler: authentication,
        schema: {
          params: route.senderParams,
          body: VerifySenderRequestSchema,
          security: [{ tenantBearer: [] }],
          response: { 200: VerifiedEmailSenderSchema, ...errors },
        },
      },
      async (request) => {
        const params = request.params as unknown as {
          tenantId: string;
          senderId: string;
          profileId?: string;
          businessId?: string;
        };
        return options.inboundEmailDomain.verifySender({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFrom(params),
          senderId: params.senderId,
          verificationToken: request.body.verificationToken,
          requestId: request.id,
        });
      },
    );

    typedApp.delete(
      `${route.base}/verified-senders/:senderId`,
      {
        preHandler: authentication,
        schema: {
          params: route.senderParams,
          security: [{ tenantBearer: [] }],
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        const params = request.params as unknown as {
          tenantId: string;
          senderId: string;
          profileId?: string;
          businessId?: string;
        };
        await options.inboundEmailDomain.revokeSender({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFrom(params),
          senderId: params.senderId,
          requestId: request.id,
        });
        return reply.code(204).send(null);
      },
    );

    typedApp.post(
      `${route.base}/routing-token`,
      {
        preHandler: authentication,
        schema: {
          params: route.collectionParams,
          security: [{ tenantBearer: [] }],
          response: { 200: RoutingTokenSchema, ...errors },
        },
      },
      async (request) => {
        const params = request.params as unknown as {
          tenantId: string;
          profileId?: string;
          businessId?: string;
        };
        return options.inboundEmailDomain.rotateRoutingToken({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFrom(params),
          requestId: request.id,
        });
      },
    );

    typedApp.get(
      `${route.base}/routing-token`,
      {
        preHandler: authentication,
        schema: {
          params: route.collectionParams,
          security: [{ tenantBearer: [] }],
          response: { 200: RoutingTokenSchema, ...errors },
        },
      },
      async (request) => {
        const params = request.params as unknown as {
          tenantId: string;
          profileId?: string;
          businessId?: string;
        };
        return options.inboundEmailDomain.getRoutingToken({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFrom(params),
        });
      },
    );

    for (const view of [
      { suffix: "/inbound-emails", quarantinedOnly: false },
      { suffix: "/quarantine", quarantinedOnly: true },
    ] as const) {
      typedApp.get(
        `${route.base}${view.suffix}`,
        {
          preHandler: authentication,
          schema: {
            params: route.collectionParams,
            security: [{ tenantBearer: [] }],
            response: { 200: InboundEmailListSchema, ...errors },
          },
        },
        async (request) => {
          const params = request.params as unknown as {
            tenantId: string;
            profileId?: string;
            businessId?: string;
          };
          return {
            items: [
              ...(await options.inboundEmailDomain.listInboundEmails({
                actorUserId: actorUserId(request),
                tenantId: params.tenantId,
                scope: scopeFrom(params),
                quarantinedOnly: view.quarantinedOnly,
              })),
            ],
          };
        },
      );
    }

    typedApp.post(
      `${route.base}/quarantine/:inboundEmailId/dismiss`,
      {
        preHandler: authentication,
        schema: {
          params: route.emailParams,
          security: [{ tenantBearer: [] }],
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        const params = request.params as unknown as {
          tenantId: string;
          inboundEmailId: string;
          profileId?: string;
          businessId?: string;
        };
        await options.inboundEmailDomain.dismissInboundEmail({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFrom(params),
          inboundEmailId: params.inboundEmailId,
          requestId: request.id,
        });
        return reply.code(204).send(null);
      },
    );
  }

  typedApp.post(
    "/internal/v1/inbound-email/provider-webhook",
    {
      schema: {
        headers: z.object({ "x-inbound-signature": z.string().min(1) }),
        response: { 202: InboundWebhookResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) throw DomainError.validation();
      if (
        !verifyWebhookSignature(
          options.webhookSigningKey,
          rawBody,
          request.headers["x-inbound-signature"],
        )
      ) {
        throw DomainError.unauthenticated();
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw DomainError.validation();
      }
      const parsed = InboundWebhookRequestSchema.safeParse(payload);
      if (!parsed.success) throw DomainError.validation();
      const result = await options.inboundEmailDomain.handleWebhook(parsed.data);
      return reply.code(202).send({
        inboundEmail: result.inboundEmail,
        createdFileIds: [...result.createdFileIds],
        createdJobIds: [...result.createdJobIds],
      });
    },
  );
}
