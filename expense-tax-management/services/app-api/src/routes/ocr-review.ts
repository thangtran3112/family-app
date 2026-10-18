import {
  BusinessOcrReviewCollectionParamsSchema,
  BusinessOcrReviewJobParamsSchema,
  CaptureOcrCompleteRequestV1Schema,
  CaptureOcrReviewCompleteResponseV1Schema,
  CaptureOcrReviewDetailV1Schema,
  CaptureOcrReviewListV1Schema,
  CaptureOcrReviewStatusQuerySchema,
  ErrorResponseSchema,
  IdempotencyKeyHeaderSchema,
  PersonalOcrReviewCollectionParamsSchema,
  PersonalOcrReviewJobParamsSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { FileScope } from "../domain/files.js";
import type { OcrReviewDomain } from "../domain/ocr-review.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface OcrReviewRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly ocrReviewDomain: OcrReviewDomain;
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

function scopeFromParams(params: { readonly profileId?: string; readonly businessId?: string }): FileScope {
  if (params.profileId !== undefined) return { kind: "personal", profileId: params.profileId };
  if (params.businessId !== undefined) return { kind: "business", businessId: params.businessId };
  throw DomainError.validation();
}

export async function registerOcrReviewRoutes(
  app: FastifyInstance,
  options: OcrReviewRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authentication = [tenantGuard, authenticatedUserGuard(options.identityResolver)];
  const scopes = [
    {
      base: "/api/v1/tenants/:tenantId/personal-profiles/:profileId",
      collectionParams: PersonalOcrReviewCollectionParamsSchema,
      jobParams: PersonalOcrReviewJobParamsSchema,
    },
    {
      base: "/api/v1/tenants/:tenantId/businesses/:businessId",
      collectionParams: BusinessOcrReviewCollectionParamsSchema,
      jobParams: BusinessOcrReviewJobParamsSchema,
    },
  ] as const;

  for (const route of scopes) {
    typedApp.get(`${route.base}/ocr-reviews`, {
      preHandler: authentication,
      schema: {
        params: route.collectionParams,
        querystring: CaptureOcrReviewStatusQuerySchema,
        security: [{ tenantBearer: [] }],
        response: { 200: CaptureOcrReviewListV1Schema, ...errors },
      },
    }, async (request) => {
      const params = request.params as unknown as {
        tenantId: string;
        profileId?: string;
        businessId?: string;
      };
      return options.ocrReviewDomain.listReviews({
        actorUserId: actorUserId(request),
        tenantId: params.tenantId,
        scope: scopeFromParams(params),
        status: request.query.status,
      });
    });

    typedApp.get(`${route.base}/ocr-jobs/:jobId/review`, {
      preHandler: authentication,
      schema: {
        params: route.jobParams,
        security: [{ tenantBearer: [] }],
        response: { 200: CaptureOcrReviewDetailV1Schema, ...errors },
      },
    }, async (request) => {
      const params = request.params as unknown as {
        tenantId: string;
        jobId: string;
        profileId?: string;
        businessId?: string;
      };
      return options.ocrReviewDomain.getReview({
        actorUserId: actorUserId(request),
        tenantId: params.tenantId,
        scope: scopeFromParams(params),
        jobId: params.jobId,
      });
    });

    typedApp.post(`${route.base}/ocr-jobs/:jobId/complete`, {
      preHandler: authentication,
      schema: {
        params: route.jobParams,
        headers: IdempotencyKeyHeaderSchema,
        body: CaptureOcrCompleteRequestV1Schema,
        security: [{ tenantBearer: [] }],
        response: { 200: CaptureOcrReviewCompleteResponseV1Schema, ...errors },
      },
    }, async (request, reply) => {
      const params = request.params as unknown as {
        tenantId: string;
        jobId: string;
        profileId?: string;
        businessId?: string;
      };
      const result = await options.ocrReviewDomain.completeReview({
        actorUserId: actorUserId(request),
        tenantId: params.tenantId,
        scope: scopeFromParams(params),
        jobId: params.jobId,
        request: request.body,
        idempotencyKey: request.headers["idempotency-key"],
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    });
  }
}
