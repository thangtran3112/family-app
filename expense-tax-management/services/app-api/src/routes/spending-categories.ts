import {
  ErrorResponseSchema,
  SpendingCategoryArchiveRequestSchema,
  SpendingCategoryCreateRequestSchema,
  SpendingCategoryListSchema,
  SpendingCategoryParamsSchema,
  SpendingCategorySchema,
  SpendingCategoryUpdateRequestSchema,
  TenantIdParamsSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { SpendingCategoryDomain } from "../domain/spending-categories.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface SpendingCategoryRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly spendingCategoryDomain: SpendingCategoryDomain;
}

const authentication = (identityResolver: IdentityResolver) => [
  tenantGuard,
  authenticatedUserGuard(identityResolver),
];
const standardErrors = {
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

export async function registerSpendingCategoryRoutes(
  app: FastifyInstance,
  options: SpendingCategoryRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const collectionPath = "/api/v1/tenants/:tenantId/spending-categories";
  const itemPath = `${collectionPath}/:categoryId`;

  typedApp.get(
    collectionPath,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TenantIdParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: SpendingCategoryListSchema, ...standardErrors },
      },
    },
    async (request) => ({
      items: [
        ...(await options.spendingCategoryDomain.list(
          actorUserId(request),
          request.params.tenantId,
        )),
      ],
    }),
  );

  typedApp.post(
    collectionPath,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TenantIdParamsSchema,
        body: SpendingCategoryCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: SpendingCategorySchema, ...standardErrors },
      },
    },
    async (request, reply) => {
      const created = await options.spendingCategoryDomain.create({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        request: request.body,
        requestId: request.id,
      });
      return reply.code(201).send(created);
    },
  );

  typedApp.patch(
    itemPath,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: SpendingCategoryParamsSchema,
        body: SpendingCategoryUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: SpendingCategorySchema, ...standardErrors },
      },
    },
    async (request) =>
      options.spendingCategoryDomain.update({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        categoryId: request.params.categoryId,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.delete(
    itemPath,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: SpendingCategoryParamsSchema,
        body: SpendingCategoryArchiveRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: SpendingCategorySchema, ...standardErrors },
      },
    },
    async (request) =>
      options.spendingCategoryDomain.archive({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        categoryId: request.params.categoryId,
        request: request.body,
        requestId: request.id,
      }),
  );
}
