import {
  AiModeCreateRequestSchema,
  AiModeListSchema,
  AiModeParamsSchema,
  AiModelCreateRequestSchema,
  AiModelListSchema,
  AiModelSchema,
  AiModeRouteVersionCreateRequestSchema,
  AiModeRouteVersionSchema,
  AiModeSchema,
  ErrorResponseSchema,
  ProviderConnectionCreateRequestSchema,
  ProviderConnectionListSchema,
  ProviderConnectionParamsSchema,
  ProviderConnectionSchema,
  ProviderConnectionUpdateRequestSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { CatalogDomain } from "../domain/catalog.js";
import { DomainError } from "../errors.js";
import { platformGuard } from "../plugins/auth.js";

export interface CatalogRouteOptions {
  readonly catalogDomain: CatalogDomain;
}

const CATALOG_MANAGER_ROLE = "catalog_manager";

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  500: ErrorResponseSchema,
};

function actorPlatformSubject(request: FastifyRequest): string {
  const subject = request.authPrincipal?.subject;
  if (!subject) throw DomainError.forbidden();
  return subject;
}

export async function registerCatalogRoutes(
  app: FastifyInstance,
  options: CatalogRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const managerGuard = [platformGuard(CATALOG_MANAGER_ROLE)];

  typedApp.post(
    "/internal/v1/provider-connections",
    {
      preHandler: managerGuard,
      schema: {
        body: ProviderConnectionCreateRequestSchema,
        security: [{ platformBearer: [] }],
        response: { 201: ProviderConnectionSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.catalogDomain.createProviderConnection({
          request: request.body,
          actorPlatformSubject: actorPlatformSubject(request),
          requestId: request.id,
        }),
      ),
  );

  typedApp.get(
    "/internal/v1/provider-connections",
    {
      preHandler: managerGuard,
      schema: {
        security: [{ platformBearer: [] }],
        response: { 200: ProviderConnectionListSchema, ...errors },
      },
    },
    async () => ({
      items: [...(await options.catalogDomain.listProviderConnections())],
    }),
  );

  typedApp.patch(
    "/internal/v1/provider-connections/:id",
    {
      preHandler: managerGuard,
      schema: {
        params: ProviderConnectionParamsSchema,
        body: ProviderConnectionUpdateRequestSchema,
        security: [{ platformBearer: [] }],
        response: { 200: ProviderConnectionSchema, ...errors },
      },
    },
    async (request) =>
      options.catalogDomain.updateProviderConnection({
        id: request.params.id,
        request: request.body,
        actorPlatformSubject: actorPlatformSubject(request),
        requestId: request.id,
      }),
  );

  typedApp.post(
    "/internal/v1/ai-models",
    {
      preHandler: managerGuard,
      schema: {
        body: AiModelCreateRequestSchema,
        security: [{ platformBearer: [] }],
        response: { 201: AiModelSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.catalogDomain.createAiModel({
          request: request.body,
          actorPlatformSubject: actorPlatformSubject(request),
          requestId: request.id,
        }),
      ),
  );

  typedApp.get(
    "/internal/v1/ai-models",
    {
      preHandler: managerGuard,
      schema: {
        security: [{ platformBearer: [] }],
        response: { 200: AiModelListSchema, ...errors },
      },
    },
    async () => ({ items: [...(await options.catalogDomain.listAiModels())] }),
  );

  typedApp.post(
    "/internal/v1/ai-modes",
    {
      preHandler: managerGuard,
      schema: {
        body: AiModeCreateRequestSchema,
        security: [{ platformBearer: [] }],
        response: { 201: AiModeSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.catalogDomain.createAiMode({
          request: request.body,
          actorPlatformSubject: actorPlatformSubject(request),
          requestId: request.id,
        }),
      ),
  );

  typedApp.get(
    "/internal/v1/ai-modes",
    {
      preHandler: managerGuard,
      schema: {
        security: [{ platformBearer: [] }],
        response: { 200: AiModeListSchema, ...errors },
      },
    },
    async () => ({ items: [...(await options.catalogDomain.listAiModes())] }),
  );

  typedApp.post(
    "/internal/v1/ai-modes/:aiModeId/route-versions",
    {
      preHandler: managerGuard,
      schema: {
        params: AiModeParamsSchema,
        body: AiModeRouteVersionCreateRequestSchema,
        security: [{ platformBearer: [] }],
        response: { 201: AiModeRouteVersionSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.catalogDomain.createRouteVersion({
          aiModeId: request.params.aiModeId,
          request: request.body,
          actorPlatformSubject: actorPlatformSubject(request),
          requestId: request.id,
        }),
      ),
  );
}
