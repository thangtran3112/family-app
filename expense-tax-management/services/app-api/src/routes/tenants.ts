import {
  ErrorResponseSchema,
  IdempotencyKeyHeaderSchema,
  TenantBootstrapSchema,
  TenantCreateRequestSchema,
  TenantIdParamsSchema,
  TenantListSchema,
  TenantSchema,
  TenantUpdateRequestSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { TenantDomain } from "../domain/tenants.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface TenantRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly tenantDomain: TenantDomain;
}

const tenantAuthentication = (identityResolver: IdentityResolver) => [
  tenantGuard,
  authenticatedUserGuard(identityResolver),
];

export async function registerTenantRoutes(
  app: FastifyInstance,
  options: TenantRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    "/api/v1/tenants",
    {
      preHandler: tenantAuthentication(options.identityResolver),
      schema: {
        headers: IdempotencyKeyHeaderSchema,
        body: TenantCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: {
          201: TenantBootstrapSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (!user) throw DomainError.unauthenticated();
      const result = await options.tenantDomain.create({
        actorUserId: user.id,
        request: request.body,
        idempotencyKey: request.headers["idempotency-key"],
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  typedApp.get(
    "/api/v1/tenants",
    {
      preHandler: tenantAuthentication(options.identityResolver),
      schema: {
        security: [{ tenantBearer: [] }],
        response: {
          200: TenantListSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const user = request.authenticatedUser;
      if (!user) throw DomainError.unauthenticated();
      return { items: [...(await options.tenantDomain.list(user.id))] };
    },
  );

  typedApp.get(
    "/api/v1/tenants/:tenantId",
    {
      preHandler: tenantAuthentication(options.identityResolver),
      schema: {
        params: TenantIdParamsSchema,
        security: [{ tenantBearer: [] }],
        response: {
          200: TenantSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const user = request.authenticatedUser;
      if (!user) throw DomainError.unauthenticated();
      return options.tenantDomain.get(user.id, request.params.tenantId);
    },
  );

  typedApp.patch(
    "/api/v1/tenants/:tenantId",
    {
      preHandler: tenantAuthentication(options.identityResolver),
      schema: {
        params: TenantIdParamsSchema,
        body: TenantUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: {
          200: TenantSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const user = request.authenticatedUser;
      if (!user) throw DomainError.unauthenticated();
      return options.tenantDomain.update({
        actorUserId: user.id,
        tenantId: request.params.tenantId,
        request: request.body,
        requestId: request.id,
      });
    },
  );
}
