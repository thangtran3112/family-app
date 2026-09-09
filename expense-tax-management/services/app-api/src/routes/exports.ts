import {
  BusinessExportParamsSchema,
  BusinessTaxReportParamsSchema,
  BusinessTaxReportSchema,
  CreateExportRequestSchema,
  ErrorResponseSchema,
  ExportBundleListQuerySchema,
  ExportBundleListSchema,
  ExportBundleParamsSchema,
  ExportBundleSchema,
  IdempotencyKeyHeaderSchema,
  ProjectCostReportParamsSchema,
  ProjectCostReportSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { ExportsDomain } from "../domain/exports.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface ExportRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly exportsDomain: ExportsDomain;
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

export async function registerExportRoutes(
  app: FastifyInstance,
  options: ExportRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authentication = [
    tenantGuard,
    authenticatedUserGuard(options.identityResolver),
  ];

  const business = "/api/v1/tenants/:tenantId/businesses/:businessId";

  typedApp.get(
    `${business}/tax-reports/:taxYear`,
    {
      preHandler: authentication,
      schema: {
        params: BusinessTaxReportParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: BusinessTaxReportSchema, ...errors },
      },
    },
    async (request) =>
      options.exportsDomain.getTaxReport({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        taxYear: request.params.taxYear,
      }),
  );

  typedApp.get(
    `${business}/projects/:projectId/cost-report`,
    {
      preHandler: authentication,
      schema: {
        params: ProjectCostReportParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ProjectCostReportSchema, ...errors },
      },
    },
    async (request) =>
      options.exportsDomain.getProjectCostReport({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        projectId: request.params.projectId,
      }),
  );

  typedApp.post(
    `${business}/exports`,
    {
      preHandler: authentication,
      schema: {
        params: BusinessExportParamsSchema,
        headers: IdempotencyKeyHeaderSchema,
        body: CreateExportRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: ExportBundleSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await options.exportsDomain.createExportBundle({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        taxYear: request.body.taxYear,
        includeUnresolved: request.body.includeUnresolved,
        idempotencyKey: request.headers["idempotency-key"],
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  typedApp.get(
    `${business}/exports`,
    {
      preHandler: authentication,
      schema: {
        params: BusinessExportParamsSchema,
        querystring: ExportBundleListQuerySchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExportBundleListSchema, ...errors },
      },
    },
    async (request) => {
      const result = await options.exportsDomain.listExportBundles({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
      return { items: [...result.items], nextCursor: result.nextCursor };
    },
  );

  typedApp.get(
    `${business}/exports/:exportId`,
    {
      preHandler: authentication,
      schema: {
        params: ExportBundleParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExportBundleSchema, ...errors },
      },
    },
    async (request) =>
      options.exportsDomain.getExportBundle({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        exportId: request.params.exportId,
        requestId: request.id,
      }),
  );
}
