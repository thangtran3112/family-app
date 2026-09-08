import {
  BusinessArchiveRequestSchema,
  BusinessBootstrapSchema,
  BusinessCreateRequestSchema,
  BusinessIndustryListSchema,
  BusinessListSchema,
  BusinessScopeParamsSchema,
  BusinessUpdateRequestSchema,
  ErrorResponseSchema,
  IdempotencyKeyHeaderSchema,
  SmallBusinessSchema,
  TenantIdParamsSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { BusinessDomain } from "../domain/businesses.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface BusinessRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly businessDomain: BusinessDomain;
}

const authentication = (identityResolver: IdentityResolver) => [
  tenantGuard,
  authenticatedUserGuard(identityResolver),
];

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  500: ErrorResponseSchema,
};

export async function registerBusinessRoutes(
  app: FastifyInstance,
  options: BusinessRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    "/api/v1/business-industries",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        security: [{ tenantBearer: [] }],
        response: { 200: BusinessIndustryListSchema, ...errorResponses },
      },
    },
    async () => ({ items: [...(await options.businessDomain.listIndustries())] }),
  );

  typedApp.post(
    "/api/v1/tenants/:tenantId/businesses",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TenantIdParamsSchema,
        headers: IdempotencyKeyHeaderSchema,
        body: BusinessCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: BusinessBootstrapSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (!user) throw DomainError.unauthenticated();
      const result = await options.businessDomain.create({
        actorUserId: user.id,
        tenantId: request.params.tenantId,
        request: request.body,
        idempotencyKey: request.headers["idempotency-key"],
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  typedApp.get(
    "/api/v1/tenants/:tenantId/businesses",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TenantIdParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: BusinessListSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.authenticatedUser;
      if (!user) throw DomainError.unauthenticated();
      return {
        items: [
          ...(await options.businessDomain.list(user.id, request.params.tenantId)),
        ],
      };
    },
  );

  typedApp.get(
    "/api/v1/tenants/:tenantId/businesses/:businessId",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessScopeParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: SmallBusinessSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.authenticatedUser;
      if (!user) throw DomainError.unauthenticated();
      return options.businessDomain.get(
        user.id,
        request.params.tenantId,
        request.params.businessId,
      );
    },
  );

  typedApp.patch(
    "/api/v1/tenants/:tenantId/businesses/:businessId",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessScopeParamsSchema,
        body: BusinessUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: SmallBusinessSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.authenticatedUser;
      if (!user) throw DomainError.unauthenticated();
      return options.businessDomain.update({
        actorUserId: user.id,
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        request: request.body,
        requestId: request.id,
      });
    },
  );

  typedApp.delete(
    "/api/v1/tenants/:tenantId/businesses/:businessId",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessScopeParamsSchema,
        body: BusinessArchiveRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: SmallBusinessSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.authenticatedUser;
      if (!user) throw DomainError.unauthenticated();
      return options.businessDomain.archive({
        actorUserId: user.id,
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        request: request.body,
        requestId: request.id,
      });
    },
  );
}
