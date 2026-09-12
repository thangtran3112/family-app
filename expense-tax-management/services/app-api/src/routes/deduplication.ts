import {
  DeduplicationEvidenceV1Schema,
  ErrorResponseSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { DeduplicationDomain } from "../domain/deduplication.js";
import { DomainError } from "../errors.js";
import { serviceGuard } from "../plugins/auth.js";

export interface DeduplicationRouteOptions {
  readonly deduplicationDomain: DeduplicationDomain;
  readonly workerServiceSubject?: string;
}

const response = z.strictObject({
  decision: z.enum(["no_match", "review"]),
  matchIds: z.array(z.uuid()),
});

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  412: ErrorResponseSchema,
  500: ErrorResponseSchema,
};

function actorServicePrincipal(request: FastifyRequest): string {
  const clientId = request.authPrincipal?.clientId;
  if (!clientId) throw DomainError.forbidden();
  return clientId;
}

export async function registerDeduplicationRoutes(
  app: FastifyInstance,
  options: DeduplicationRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  typedApp.post(
    "/internal/v1/jobs/:jobId/deduplication",
    {
      preHandler: [
        serviceGuard(options.workerServiceSubject ?? "ai-worker", ["jobs:write"]),
      ],
      schema: {
        hide: true,
        params: z.strictObject({ jobId: z.uuid() }),
        body: DeduplicationEvidenceV1Schema,
        security: [{ serviceBearer: [] }],
        response: { 200: response, ...errors },
      },
    },
    async (request) => {
      if (request.body.jobId !== request.params.jobId) throw DomainError.validation();
      const result = await options.deduplicationDomain.recordEvidence({
        request: request.body,
        actorServicePrincipal: actorServicePrincipal(request),
        requestId: request.id,
      });
      return { decision: result.decision, matchIds: [...result.matchIds] };
    },
  );
}
