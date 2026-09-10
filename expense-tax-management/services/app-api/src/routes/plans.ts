import {
  ActivePlanListSchema,
  EntitlementSnapshotListSchema,
  EntitlementSnapshotQuerySchema,
  ErrorResponseSchema,
  EffectiveEntitlementListSchema,
  FeatureDefinitionCreateRequestSchema,
  FeatureDefinitionSchema,
  PlanCreateRequestSchema,
  PlanListSchema,
  PlanParamsSchema,
  PlanSchema,
  PlanVersionCreateRequestSchema,
  PlanVersionSchema,
  TenantAddonCreateRequestSchema,
  TenantAddonParamsSchema,
  TenantAddonSchema,
  TenantScopeParamsSchema,
  TenantSubscriptionSchema,
  TenantSubscriptionUpdateRequestSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { PlansDomain } from "../domain/plans.js";
import { DomainError } from "../errors.js";
import {
  authenticatedUserGuard,
  serviceGuard,
  tenantGuard,
} from "../plugins/auth.js";

export interface PlanRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly plansDomain: PlansDomain;
  readonly foundryServiceSubject?: string;
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

function actorServicePrincipal(request: FastifyRequest): string {
  const clientId = request.authPrincipal?.clientId;
  if (!clientId) throw DomainError.forbidden();
  return clientId;
}

export async function registerPlanRoutes(
  app: FastifyInstance,
  options: PlanRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const tenantAuthentication = [
    tenantGuard,
    authenticatedUserGuard(options.identityResolver),
  ];
  const adminGuard = [serviceGuard("platform-admin", ["plans:manage"])];
  const foundryGuard = [
    serviceGuard(
      options.foundryServiceSubject ?? "foundry-service",
      ["entitlements:read"],
    ),
  ];

  typedApp.post(
    "/internal/v1/plans",
    {
      preHandler: adminGuard,
      schema: {
        body: PlanCreateRequestSchema,
        security: [{ serviceBearer: [] }],
        response: { 201: PlanSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.plansDomain.createPlan({
          request: request.body,
          actorServicePrincipal: actorServicePrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  typedApp.post(
    "/internal/v1/plans/:planId/versions",
    {
      preHandler: adminGuard,
      schema: {
        params: PlanParamsSchema,
        body: PlanVersionCreateRequestSchema,
        security: [{ serviceBearer: [] }],
        response: { 201: PlanVersionSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.plansDomain.createPlanVersion({
          planId: request.params.planId,
          request: request.body,
          actorServicePrincipal: actorServicePrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  typedApp.get(
    "/internal/v1/plans",
    {
      preHandler: adminGuard,
      schema: {
        security: [{ serviceBearer: [] }],
        response: { 200: PlanListSchema, ...errors },
      },
    },
    async () => ({ items: [...(await options.plansDomain.listPlansAdmin())] }),
  );

  typedApp.post(
    "/internal/v1/feature-definitions",
    {
      preHandler: adminGuard,
      schema: {
        body: FeatureDefinitionCreateRequestSchema,
        security: [{ serviceBearer: [] }],
        response: { 201: FeatureDefinitionSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.plansDomain.createFeatureDefinition({
          request: request.body,
          actorServicePrincipal: actorServicePrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  typedApp.get(
    "/internal/v1/entitlement-snapshots",
    {
      preHandler: foundryGuard,
      schema: {
        querystring: EntitlementSnapshotQuerySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: EntitlementSnapshotListSchema, ...errors },
      },
    },
    async (request) => {
      const result = await options.plansDomain.listEntitlementSnapshotsAfter({
        afterSequence: request.query.afterSequence ?? 0,
        limit: request.query.limit ?? 100,
      });
      return {
        items: [...result.items],
        nextAfterSequence: result.nextAfterSequence,
      };
    },
  );

  typedApp.get(
    "/api/v1/plans",
    {
      preHandler: tenantAuthentication,
      schema: {
        security: [{ tenantBearer: [] }],
        response: { 200: ActivePlanListSchema, ...errors },
      },
    },
    async () => ({ items: [...(await options.plansDomain.listActivePlans())] }),
  );

  typedApp.get(
    "/api/v1/tenants/:tenantId/subscription",
    {
      preHandler: tenantAuthentication,
      schema: {
        params: TenantScopeParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: TenantSubscriptionSchema, ...errors },
      },
    },
    async (request) =>
      options.plansDomain.getSubscription({ tenantId: request.params.tenantId }),
  );

  typedApp.put(
    "/api/v1/tenants/:tenantId/subscription",
    {
      preHandler: tenantAuthentication,
      schema: {
        params: TenantScopeParamsSchema,
        body: TenantSubscriptionUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: TenantSubscriptionSchema, ...errors },
      },
    },
    async (request) =>
      options.plansDomain.updateSubscription({
        tenantId: request.params.tenantId,
        actorUserId: actorUserId(request),
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.post(
    "/api/v1/tenants/:tenantId/addons",
    {
      preHandler: tenantAuthentication,
      schema: {
        params: TenantScopeParamsSchema,
        body: TenantAddonCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: TenantAddonSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.plansDomain.addAddon({
          tenantId: request.params.tenantId,
          actorUserId: actorUserId(request),
          request: request.body,
          requestId: request.id,
        }),
      ),
  );

  typedApp.delete(
    "/api/v1/tenants/:tenantId/addons/:featureKey",
    {
      preHandler: tenantAuthentication,
      schema: {
        params: TenantAddonParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await options.plansDomain.removeAddon({
        tenantId: request.params.tenantId,
        actorUserId: actorUserId(request),
        featureKey: request.params.featureKey,
        requestId: request.id,
      });
      return reply.code(204).send(null);
    },
  );

  typedApp.get(
    "/api/v1/tenants/:tenantId/entitlements",
    {
      preHandler: tenantAuthentication,
      schema: {
        params: TenantScopeParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: EffectiveEntitlementListSchema, ...errors },
      },
    },
    async (request) => ({
      items: [
        ...(await options.plansDomain.resolveEffectiveEntitlements({
          tenantId: request.params.tenantId,
          actorUserId: actorUserId(request),
        })),
      ],
    }),
  );
}
