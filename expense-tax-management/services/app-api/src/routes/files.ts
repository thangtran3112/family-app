import {
  BusinessFileCollectionParamsSchema,
  BusinessFileParamsSchema,
  BusinessUploadSessionParamsSchema,
  CreateUploadSessionRequestSchema,
  CreateUploadSessionResponseSchema,
  ErrorResponseSchema,
  ExpenseFileSchema,
  FileContentQuerySchema,
  FileListQuerySchema,
  FileListSchema,
  FileReadUrlResponseSchema,
  IdempotencyKeyHeaderSchema,
  InternalFileParamsSchema,
  MAX_UPLOAD_BYTES,
  PersonalFileCollectionParamsSchema,
  PersonalFileParamsSchema,
  PersonalUploadSessionParamsSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { FileScope, FilesDomain } from "../domain/files.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, serviceGuard, tenantGuard } from "../plugins/auth.js";
import {
  toEpochSec,
  verifyContentSignature,
} from "../storage/signing.js";

export interface FileRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly filesDomain: FilesDomain;
  readonly contentSigningKey: string;
  readonly workerServiceSubject?: string;
}

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  410: ErrorResponseSchema,
  413: ErrorResponseSchema,
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

export async function registerFileRoutes(
  app: FastifyInstance,
  options: FileRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authentication = [
    tenantGuard,
    authenticatedUserGuard(options.identityResolver),
  ];
  const workerGuard = [
    serviceGuard(options.workerServiceSubject ?? "ai-worker", ["files:read"]),
  ];

  typedApp.addContentTypeParser(
    ["image/jpeg", "image/png", "image/webp", "application/pdf"],
    { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
    async (_request: FastifyRequest, body: unknown) => body,
  );

  const personalCollection =
    "/api/v1/tenants/:tenantId/personal-profiles/:profileId/files";
  const businessCollection =
    "/api/v1/tenants/:tenantId/businesses/:businessId/files";

  const collectionRoutes = [
    {
      path: personalCollection,
      params: PersonalFileCollectionParamsSchema,
    },
    {
      path: businessCollection,
      params: BusinessFileCollectionParamsSchema,
    },
  ] as const;

  for (const collection of collectionRoutes) {
    typedApp.post(
      `${collection.path}/upload-sessions`,
      {
        preHandler: authentication,
        schema: {
          params: collection.params,
          headers: IdempotencyKeyHeaderSchema,
          body: CreateUploadSessionRequestSchema,
          security: [{ tenantBearer: [] }],
          response: { 201: CreateUploadSessionResponseSchema, ...errors },
        },
      },
      async (request, reply) => {
        const params = request.params as unknown as {
          readonly tenantId: string;
          readonly profileId?: string;
          readonly businessId?: string;
        };
        const result = await options.filesDomain.createUploadSession({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFromParams(params),
          request: request.body,
          idempotencyKey: request.headers["idempotency-key"],
          requestId: request.id,
        });
        return reply.code(result.statusCode).send(result.body);
      },
    );

    typedApp.get(
      collection.path,
      {
        preHandler: authentication,
        schema: {
          params: collection.params,
          querystring: FileListQuerySchema,
          security: [{ tenantBearer: [] }],
          response: { 200: FileListSchema, ...errors },
        },
      },
      async (request) => {
        const params = request.params as unknown as {
          readonly tenantId: string;
          readonly profileId?: string;
          readonly businessId?: string;
        };
        return options.filesDomain.listFiles({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFromParams(params),
          limit: request.query.limit,
          cursor: request.query.cursor,
        });
      },
    );
  }

  const itemRoutes = [
    {
      base: `${personalCollection}/:fileId`,
      params: PersonalFileParamsSchema,
    },
    {
      base: `${businessCollection}/:fileId`,
      params: BusinessFileParamsSchema,
    },
  ] as const;

  for (const item of itemRoutes) {
    typedApp.get(
      item.base,
      {
        preHandler: authentication,
        schema: {
          params: item.params,
          security: [{ tenantBearer: [] }],
          response: { 200: ExpenseFileSchema, ...errors },
        },
      },
      async (request) => {
        const params = request.params as unknown as {
          readonly tenantId: string;
          readonly fileId: string;
          readonly profileId?: string;
          readonly businessId?: string;
        };
        return options.filesDomain.getFile({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFromParams(params),
          fileId: params.fileId,
        });
      },
    );

    typedApp.delete(
      item.base,
      {
        preHandler: authentication,
        schema: {
          params: item.params,
          security: [{ tenantBearer: [] }],
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        const params = request.params as unknown as {
          readonly tenantId: string;
          readonly fileId: string;
          readonly profileId?: string;
          readonly businessId?: string;
        };
        await options.filesDomain.deleteFile({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFromParams(params),
          fileId: params.fileId,
          requestId: request.id,
        });
        return reply.code(204).send(null);
      },
    );

    typedApp.post(
      `${item.base}/read-url`,
      {
        preHandler: authentication,
        schema: {
          params: item.params,
          security: [{ tenantBearer: [] }],
          response: { 200: FileReadUrlResponseSchema, ...errors },
        },
      },
      async (request) => {
        const params = request.params as unknown as {
          readonly tenantId: string;
          readonly fileId: string;
          readonly profileId?: string;
          readonly businessId?: string;
        };
        return options.filesDomain.issueFileReadUrl({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFromParams(params),
          fileId: params.fileId,
        });
      },
    );
  }

  const confirmRoutes = [
    {
      path: `${personalCollection}/upload-sessions/:sessionId/confirm`,
      params: PersonalUploadSessionParamsSchema,
    },
    {
      path: `${businessCollection}/upload-sessions/:sessionId/confirm`,
      params: BusinessUploadSessionParamsSchema,
    },
  ] as const;

  for (const route of confirmRoutes) {
    typedApp.post(
      route.path,
      {
        preHandler: authentication,
        schema: {
          params: route.params,
          security: [{ tenantBearer: [] }],
          response: { 200: ExpenseFileSchema, ...errors },
        },
      },
      async (request) => {
        const params = request.params as unknown as {
          readonly tenantId: string;
          readonly sessionId: string;
          readonly profileId?: string;
          readonly businessId?: string;
        };
        return options.filesDomain.confirmUploadSession({
          actorUserId: actorUserId(request),
          tenantId: params.tenantId,
          scope: scopeFromParams(params),
          sessionId: params.sessionId,
          requestId: request.id,
        });
      },
    );
  }

  typedApp.post(
    "/internal/v1/files/:fileId/read-url",
    {
      preHandler: workerGuard,
      schema: {
        params: InternalFileParamsSchema,
        security: [{ serviceBearer: [] }],
        response: { 200: FileReadUrlResponseSchema, ...errors },
      },
    },
    async (request) =>
      options.filesDomain.issueWorkerReadUrl({
        fileId: request.params.fileId,
        actorServicePrincipal: actorServicePrincipal(request),
        requestId: request.id,
      }),
  );

  function verifySignedContent(
    request: FastifyRequest,
    method: "PUT" | "GET",
  ): string {
    const params = request.params as { fileId: string };
    const query = request.query as { expires?: string; signature?: string };
    const parsed = FileContentQuerySchema.safeParse(query);
    if (!parsed.success) throw DomainError.forbidden();
    const expiresEpochSec = Number(parsed.data.expires);
    const verdict = verifyContentSignature({
      signingKey: options.contentSigningKey,
      method,
      fileId: params.fileId,
      expiresEpochSec,
      signature: parsed.data.signature,
      nowEpochSec: toEpochSec(new Date()),
    });
    if (verdict === "expired") throw DomainError.gone("Content URL has expired");
    if (verdict === "invalid") throw DomainError.forbidden();
    return params.fileId;
  }

  typedApp.put(
    "/api/v1/file-content/:fileId",
    {
      schema: {
        params: InternalFileParamsSchema,
        querystring: FileContentQuerySchema,
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      const fileId = verifySignedContent(request, "PUT");
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string") throw DomainError.validation();
      const data = request.body as unknown;
      if (!Buffer.isBuffer(data)) throw DomainError.validation();
      await options.filesDomain.writePendingContent({
        fileId,
        data,
        contentType: contentType.split(";")[0]?.trim() ?? "",
      });
      return reply.code(204).send(null);
    },
  );

  typedApp.get(
    "/api/v1/file-content/:fileId",
    {
      // No `response` schema: the body is raw file bytes, not JSON, and
      // must bypass the Zod serializer. Params/querystring are still
      // validated; the signature check inside the handler is the auth.
      schema: {
        params: InternalFileParamsSchema,
        querystring: FileContentQuerySchema,
      },
    },
    async (request, reply) => {
      const fileId = verifySignedContent(request, "GET");
      const content = await options.filesDomain.readReadyContent(fileId);
      return reply.type(content.contentType).send(content.data);
    },
  );
}
