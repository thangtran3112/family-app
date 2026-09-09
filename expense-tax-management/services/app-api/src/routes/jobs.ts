import {
  AI_WORKER_TASK_QUEUE,
  DispatchPendingJobsResponseSchema,
  ErrorResponseSchema,
  FOUNDATION_ECHO_WORKFLOW_TYPE,
  JobResultSubmitRequestV1Schema,
  JobStatusUpdateRequestV1Schema,
  ProcessingJobParamsSchema,
  ProcessingJobSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { ProcessingJobsDomain } from "../domain/processing-jobs.js";
import { DomainError } from "../errors.js";
import { serviceGuard } from "../plugins/auth.js";

export interface JobRouteOptions {
  readonly processingJobsDomain: ProcessingJobsDomain;
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

const FoundationEchoRequestSchema = z.strictObject({
  tenantId: z.uuid(),
  personalProfileId: z.uuid().optional(),
  businessId: z.uuid().optional(),
});

function actorServicePrincipal(request: FastifyRequest): string {
  const clientId = request.authPrincipal?.clientId;
  if (!clientId) throw DomainError.forbidden();
  return clientId;
}

export async function registerJobRoutes(
  app: FastifyInstance,
  options: JobRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const adminGuard = [serviceGuard("platform-admin", ["jobs:manage"])];
  const workerGuard = [serviceGuard("ai-worker", ["jobs:write"])];

  typedApp.post(
    "/internal/v1/jobs/foundation-echo",
    {
      preHandler: adminGuard,
      schema: {
        body: FoundationEchoRequestSchema,
        security: [{ serviceBearer: [] }],
        response: { 201: ProcessingJobSchema, ...errors },
      },
    },
    async (request, reply) => {
      const scope =
        request.body.personalProfileId !== undefined
          ? { personalProfileId: request.body.personalProfileId }
          : request.body.businessId !== undefined
            ? { businessId: request.body.businessId }
            : undefined;
      if (!scope) throw DomainError.validation();

      return reply.code(201).send(
        await options.processingJobsDomain.createJob({
          tenantId: request.body.tenantId,
          scope,
          workflowType: FOUNDATION_ECHO_WORKFLOW_TYPE,
          taskQueue: AI_WORKER_TASK_QUEUE,
          allowedResultSchemaVersion: "foundation-echo-v1",
          actorServicePrincipal: actorServicePrincipal(request),
          requestId: request.id,
        }),
      );
    },
  );

  typedApp.post(
    "/internal/v1/jobs/dispatch",
    {
      preHandler: adminGuard,
      schema: {
        security: [{ serviceBearer: [] }],
        response: { 200: DispatchPendingJobsResponseSchema, ...errors },
      },
    },
    async () => options.processingJobsDomain.dispatchPendingJobs({}),
  );

  typedApp.get(
    "/internal/v1/jobs/:jobId",
    {
      preHandler: adminGuard,
      schema: {
        params: ProcessingJobParamsSchema,
        security: [{ serviceBearer: [] }],
        response: { 200: ProcessingJobSchema, ...errors },
      },
    },
    async (request) => options.processingJobsDomain.getJob(request.params.jobId),
  );

  typedApp.post(
    "/internal/v1/jobs/:jobId/status",
    {
      preHandler: workerGuard,
      schema: {
        params: ProcessingJobParamsSchema,
        body: JobStatusUpdateRequestV1Schema,
        security: [{ serviceBearer: [] }],
        response: { 200: ProcessingJobSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await options.processingJobsDomain.recordStatusUpdate({
        jobId: request.params.jobId,
        request: request.body,
        actorServicePrincipal: actorServicePrincipal(request),
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  typedApp.post(
    "/internal/v1/jobs/:jobId/result",
    {
      preHandler: workerGuard,
      schema: {
        params: ProcessingJobParamsSchema,
        body: JobResultSubmitRequestV1Schema,
        security: [{ serviceBearer: [] }],
        response: { 200: ProcessingJobSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await options.processingJobsDomain.submitResult({
        jobId: request.params.jobId,
        request: request.body,
        actorServicePrincipal: actorServicePrincipal(request),
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );
}
