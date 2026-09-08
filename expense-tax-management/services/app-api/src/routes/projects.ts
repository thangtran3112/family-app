import {
  ErrorResponseSchema,
  ProjectArchiveRequestSchema,
  ProjectCollectionParamsSchema,
  ProjectCreateRequestSchema,
  ProjectListSchema,
  ProjectParamsSchema,
  ProjectSchema,
  ProjectUpdateRequestSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { ProjectDomain } from "../domain/projects.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface ProjectRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly projectDomain: ProjectDomain;
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

export async function registerProjectRoutes(
  app: FastifyInstance,
  options: ProjectRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const collectionPath =
    "/api/v1/tenants/:tenantId/businesses/:businessId/projects";
  const itemPath = `${collectionPath}/:projectId`;

  typedApp.get(
    collectionPath,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: ProjectCollectionParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ProjectListSchema, ...standardErrors },
      },
    },
    async (request) => ({
      items: [
        ...(await options.projectDomain.list(
          actorUserId(request),
          request.params.tenantId,
          request.params.businessId,
        )),
      ],
    }),
  );

  typedApp.get(
    itemPath,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: ProjectParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ProjectSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.projectDomain.get(
        actorUserId(request),
        request.params.tenantId,
        request.params.businessId,
        request.params.projectId,
      ),
  );

  typedApp.post(
    collectionPath,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: ProjectCollectionParamsSchema,
        body: ProjectCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: ProjectSchema, ...standardErrors },
      },
    },
    async (request, reply) => {
      const created = await options.projectDomain.create({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
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
        params: ProjectParamsSchema,
        body: ProjectUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ProjectSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.projectDomain.update({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        projectId: request.params.projectId,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.delete(
    itemPath,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: ProjectParamsSchema,
        body: ProjectArchiveRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ProjectSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.projectDomain.archive({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        projectId: request.params.projectId,
        request: request.body,
        requestId: request.id,
      }),
  );
}
