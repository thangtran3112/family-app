import {
  AiQuotaReservationCreateRequestSchema,
  AiQuotaReservationSchema,
  EffectiveRouteQuerySchema,
  EffectiveRouteResponseSchema,
  EntitlementSyncRequestSchema,
  EntitlementSyncResponseSchema,
  ErrorResponseSchema,
  ProviderCallOutcomeRequestSchema,
  ProviderCallStartedRequestSchema,
  QuotaStatusQuerySchema,
  QuotaStatusResponseSchema,
  ReconciliationResolveRequestSchema,
  ReservationAttemptParamsSchema,
  ReservationParamsSchema,
  TenantAiQuotaCreateRequestSchema,
  TenantAiQuotaListSchema,
  TenantAiQuotaSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { Kysely } from "kysely";
import type { FoundryDatabase } from "../database/types.js";
import { syncEntitlementsFromOutbox } from "../domain/entitlement-sync.js";
import type { QuotasDomain } from "../domain/quotas.js";
import type { RoutesDomain } from "../domain/routes.js";
import { DomainError } from "../errors.js";
import { platformGuard, serviceGuard } from "../plugins/auth.js";

export interface QuotaRouteOptions {
  readonly quotasDomain: QuotasDomain;
  readonly routesDomain: RoutesDomain;
  readonly database: Kysely<FoundryDatabase>;
  readonly workerServiceSubject?: string;
  readonly appServiceSubject?: string;
}

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

export async function registerQuotaRoutes(
  app: FastifyInstance,
  options: QuotaRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const catalogManagerGuard = [platformGuard("catalog_manager")];
  const workerSubject = options.workerServiceSubject ?? "ai-worker";
  const workerGuard = [serviceGuard(workerSubject, ["reservations:write"])];
  const routeReaderGuard = [serviceGuard(workerSubject, ["routes:read"])];
  const reconcilerGuard = [platformGuard("quota_reconciler")];
  const appApiGuard = [
    serviceGuard(options.appServiceSubject ?? "app-api", ["quota-status:read"]),
  ];

  typedApp.post(
    "/internal/v1/tenant-ai-quotas",
    {
      preHandler: catalogManagerGuard,
      schema: {
        body: TenantAiQuotaCreateRequestSchema,
        security: [{ platformBearer: [] }],
        response: { 201: TenantAiQuotaSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.quotasDomain.createTenantAiQuota({
          request: request.body,
          actorPlatformSubject: actorPlatformSubject(request),
          requestId: request.id,
        }),
      ),
  );

  typedApp.get(
    "/internal/v1/tenant-ai-quotas",
    {
      preHandler: catalogManagerGuard,
      schema: {
        security: [{ platformBearer: [] }],
        response: { 200: TenantAiQuotaListSchema, ...errors },
      },
    },
    async () => ({ items: [...(await options.quotasDomain.listTenantAiQuotas())] }),
  );

  typedApp.post(
    "/internal/v1/ai-quota-reservations",
    {
      preHandler: workerGuard,
      schema: {
        body: AiQuotaReservationCreateRequestSchema,
        security: [{ serviceBearer: [] }],
        response: { 201: AiQuotaReservationSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.quotasDomain.reserve({
          request: request.body,
          requestId: request.id,
        }),
      ),
  );

  typedApp.post(
    "/internal/v1/ai-quota-reservations/:id/call-started",
    {
      preHandler: workerGuard,
      schema: {
        params: ReservationParamsSchema,
        body: ProviderCallStartedRequestSchema,
        security: [{ serviceBearer: [] }],
        response: { 200: AiQuotaReservationSchema, ...errors },
      },
    },
    async (request) => {
      const result = await options.quotasDomain.recordCallAttempt({
        reservationId: request.params.id,
        request: request.body,
        requestId: request.id,
      });
      return result.reservation;
    },
  );

  typedApp.post(
    "/internal/v1/ai-quota-reservations/:id/attempts/:attemptNumber/outcome",
    {
      preHandler: workerGuard,
      schema: {
        params: ReservationAttemptParamsSchema,
        body: ProviderCallOutcomeRequestSchema,
        security: [{ serviceBearer: [] }],
        response: { 200: AiQuotaReservationSchema, ...errors },
      },
    },
    async (request) =>
      options.quotasDomain.recordProviderOutcome({
        reservationId: request.params.id,
        attemptNumber: request.params.attemptNumber,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.post(
    "/internal/v1/ai-quota-reservations/:id/reconciliation-required",
    {
      preHandler: workerGuard,
      schema: {
        params: ReservationParamsSchema,
        security: [{ serviceBearer: [] }],
        response: { 200: AiQuotaReservationSchema, ...errors },
      },
    },
    async (request) =>
      options.quotasDomain.markReconciliationRequired({
        reservationId: request.params.id,
        requestId: request.id,
      }),
  );

  typedApp.post(
    "/internal/v1/ai-quota-reservations/:id/release",
    {
      preHandler: workerGuard,
      schema: {
        params: ReservationParamsSchema,
        security: [{ serviceBearer: [] }],
        response: { 200: AiQuotaReservationSchema, ...errors },
      },
    },
    async (request) =>
      options.quotasDomain.release({
        reservationId: request.params.id,
        requestId: request.id,
      }),
  );

  typedApp.post(
    "/internal/v1/ai-quota-reservations/:id/resolve",
    {
      preHandler: reconcilerGuard,
      schema: {
        params: ReservationParamsSchema,
        body: ReconciliationResolveRequestSchema,
        security: [{ platformBearer: [] }],
        response: { 200: AiQuotaReservationSchema, ...errors },
      },
    },
    async (request) =>
      options.quotasDomain.resolveReconciliation({
        reservationId: request.params.id,
        resolvedBySubject: actorPlatformSubject(request),
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.post(
    "/internal/v1/entitlement-sync",
    {
      preHandler: catalogManagerGuard,
      schema: {
        body: EntitlementSyncRequestSchema,
        security: [{ platformBearer: [] }],
        response: { 200: EntitlementSyncResponseSchema, ...errors },
      },
    },
    async (request) =>
      syncEntitlementsFromOutbox(options.database, {
        appApiBaseUrl: request.body.appApiBaseUrl,
        appApiServiceToken: request.body.appApiServiceToken,
        ...(request.body.limit === undefined ? {} : { limit: request.body.limit }),
      }),
  );

  typedApp.get(
    "/internal/v1/quota-status",
    {
      preHandler: appApiGuard,
      schema: {
        querystring: QuotaStatusQuerySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: QuotaStatusResponseSchema, ...errors },
      },
    },
    async (request) =>
      options.quotasDomain.getQuotaStatus({
        tenantId: request.query.tenantId,
        operation: request.query.operation,
      }),
  );

  typedApp.get(
    "/internal/v1/effective-route",
    {
      preHandler: routeReaderGuard,
      schema: {
        querystring: EffectiveRouteQuerySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: EffectiveRouteResponseSchema, ...errors },
      },
    },
    async (request) =>
      options.routesDomain.resolveEffectiveRoute({
        operation: request.query.operation,
        modeKey: request.query.modeKey,
      }),
  );
}
