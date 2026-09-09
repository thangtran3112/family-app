import {
  BusinessOcrJobParamsSchema,
  CreateOcrJobRequestSchema,
  ErrorResponseSchema,
  IdempotencyKeyHeaderSchema,
  OcrJobInputV1Schema,
  OcrJobListSchema,
  PersonalOcrJobParamsSchema,
  ProcessingJobParamsSchema,
  ProcessingJobSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { FileScope } from "../domain/files.js";
import type { OcrJobsDomain } from "../domain/ocr.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, serviceGuard, tenantGuard } from "../plugins/auth.js";

export interface OcrRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly ocrJobsDomain: OcrJobsDomain;
}

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  412: ErrorResponseSchema,
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

function scopeFromParams(params: {
  readonly profileId?: string;
  readonly businessId?: string;
}): FileScope {
  if (params.profileId !== undefined) {
    return { kind: "personal", profileId: params.profileId };
  }
  if (params.businessId !== undefined) {
    return { kind: "business", businessId: params.businessId };
  }
  throw DomainError.validation();
}

export async function registerOcrRoutes(
  app: FastifyInstance,
  options: OcrRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authentication = [
    tenantGuard,
    authenticatedUserGuard(options.identityResolver),
  ];
  // Job-input reads ride on the worker's existing write scope: input is
  // part of the assigned-job write flow, and a second scope would double
  // the test matrix for zero security gain (same principal, same jobs).
  const workerGuard = [serviceGuard("ai-worker", ["jobs:write"])];

  const jobRoutes = [
    {
      base: "/api/v1/tenants/:tenantId/personal-profiles/:profileId/files/:fileId",
      params: PersonalOcrJobParamsSchema,
    },
    {
      base: "/api/v1/tenants/:tenantId/businesses/:businessId/files/:fileId",
      params: BusinessOcrJobParamsSchema,
    },
  ] as const;

  for (const route of jobRoutes) {
    typedApp.post(
      `${route.base}/ocr-jobs`,
      {
        preHandler: authentication,
        schema: {
          params: route.params,
          headers: IdempotencyKeyHeaderSchema,
          body: CreateOcrJobRequestSchema,
          security: [{ tenantBearer: [] }],
          response: { 201: ProcessingJobSchema, ...errors },
        },
      },
      async (request, reply) => {
        const params = request.params as unknown as {
          readonly tenantId: string;
          readonly fileId: string;
          readonly profileId?: string;
          readonly businessId?: string;
        };
        const result = await options.ocrJobsDomain.createOcrJob({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFromParams(params),
          fileId: params.fileId,
          modeKey: request.body.modeKey,
          idempotencyKey: request.headers["idempotency-key"],
          requestId: request.id,
        });
        return reply.code(result.statusCode).send(result.body);
      },
    );

    typedApp.get(
      `${route.base}/ocr-jobs`,
      {
        preHandler: authentication,
        schema: {
          params: route.params,
          security: [{ tenantBearer: [] }],
          response: { 200: OcrJobListSchema, ...errors },
        },
      },
      async (request) => {
        const params = request.params as unknown as {
          readonly tenantId: string;
          readonly fileId: string;
          readonly profileId?: string;
          readonly businessId?: string;
        };
        const result = await options.ocrJobsDomain.listOcrJobs({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFromParams(params),
          fileId: params.fileId,
        });
        return { items: [...result.items] };
      },
    );
  }

  typedApp.get(
    "/internal/v1/jobs/:jobId/ocr-input",
    {
      preHandler: workerGuard,
      schema: {
        params: ProcessingJobParamsSchema,
        security: [{ serviceBearer: [] }],
        response: { 200: OcrJobInputV1Schema, ...errors },
      },
    },
    async (request) =>
      options.ocrJobsDomain.getOcrInput({
        jobId: request.params.jobId,
        actorServicePrincipal: actorServicePrincipal(request),
        requestId: request.id,
      }),
  );
}
