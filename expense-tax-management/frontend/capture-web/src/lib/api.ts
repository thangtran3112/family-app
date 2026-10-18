import {
  createAppApiClient,
  type CaptureOcrCompleteRequestV1,
  type CaptureOcrReviewCompleteResponseV1,
  type CaptureOcrReviewDetailV1,
  type CaptureOcrReviewItemV1,
  type ProcessingJob,
  type TenantScopes,
} from "@expense-tax/contracts";

import type { QueueItem } from "./queue";
import type { CaptureSession } from "./session";
import { getAppAuthorization, type ClerkGetToken } from "./clerk";

export class CaptureApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CaptureApiError";
  }
}

function requestStatus(result: { response?: Response }): number | undefined {
  return result.response?.status;
}

/**
 * Web session wiring design (2026-10-06) -- the Settings scope picker's
 * authorized choices: the caller's own personal profile (0 or 1) and
 * every active business they have a membership on.
 */
export async function fetchTenantScopes(
  session: CaptureSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
): Promise<TenantScopes> {
  const authorization = await getAppAuthorization(getToken, organizationId);
  const client = createAppApiClient(session.apiBaseUrl);
  const result = await client.GET("/api/v1/tenants/{tenantId}/scopes", {
    params: { path: { tenantId: session.tenantId } },
    headers: authorization,
  });
  if (!result.data) throw new Error("Could not load profiles");
  return result.data;
}

export async function uploadQueuedReceipt(
  session: CaptureSession,
  item: QueueItem,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  const authorization = await getAppAuthorization(getToken, organizationId);
  const client = createAppApiClient(session.apiBaseUrl);
  const body = {
    originalFilename: item.filename,
    contentType: item.contentType as
      | "image/jpeg"
      | "image/png"
      | "image/webp"
      | "application/pdf",
    expectedSizeBytes: item.file.size,
  };
  const idempotencyKey = `capture:${item.id}:file`;

  const created =
    session.scope.kind === "personal"
      ? await client.POST(
          "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/upload-sessions",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                profileId: session.scope.profileId,
              },
              header: { "idempotency-key": idempotencyKey },
            },
            headers: authorization,
            body,
          },
        )
      : await client.POST(
          "/api/v1/tenants/{tenantId}/businesses/{businessId}/files/upload-sessions",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                businessId: session.scope.businessId,
              },
              header: { "idempotency-key": idempotencyKey },
            },
            headers: authorization,
            body,
          },
        );
  if (created.error || !created.data) {
    throw new Error("Could not create upload session");
  }
  const target = created.data.uploadTarget;
  const put = await fetch(target.url, {
    method: "PUT",
    headers: target.requiredHeaders,
    body: item.file,
  });
  if (!put.ok) throw new Error(`Direct upload failed (${put.status})`);

  const confirm =
    session.scope.kind === "personal"
      ? await client.POST(
          "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/upload-sessions/{sessionId}/confirm",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                profileId: session.scope.profileId,
                sessionId: created.data.uploadSession.id,
              },
            },
            headers: authorization,
          },
        )
      : await client.POST(
          "/api/v1/tenants/{tenantId}/businesses/{businessId}/files/upload-sessions/{sessionId}/confirm",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                businessId: session.scope.businessId,
                sessionId: created.data.uploadSession.id,
              },
            },
            headers: authorization,
          },
        );
  if (confirm.error || !confirm.data) throw new Error("Could not confirm upload");

  const ocrIdempotencyKey = `capture:${item.id}:ocr`;
  const ocr =
    session.scope.kind === "personal"
      ? await client.POST(
          "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/{fileId}/ocr-jobs",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                profileId: session.scope.profileId,
                fileId: confirm.data.id,
              },
              header: { "idempotency-key": ocrIdempotencyKey },
            },
            headers: authorization,
            body: { modeKey: item.modeKey, reviewPolicy: "capture_required_fields_v1" },
          },
        )
      : await client.POST(
          "/api/v1/tenants/{tenantId}/businesses/{businessId}/files/{fileId}/ocr-jobs",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                businessId: session.scope.businessId,
                fileId: confirm.data.id,
              },
              header: { "idempotency-key": ocrIdempotencyKey },
            },
            headers: authorization,
            body: { modeKey: item.modeKey, reviewPolicy: "capture_required_fields_v1" },
          },
        );
  if (ocr.error || !ocr.data) throw new Error("Could not start OCR");
  return { fileId: confirm.data.id, jobId: ocr.data.id };
}

export async function fetchOcrReviews(
  session: CaptureSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
): Promise<CaptureOcrReviewItemV1[]> {
  const authorization = await getAppAuthorization(getToken, organizationId);
  const client = createAppApiClient(session.apiBaseUrl);
  const items: CaptureOcrReviewItemV1[] = [];
  let cursor: string | undefined;
  do {
    const query = { status: "needs_input" as const, limit: 100, ...(cursor ? { cursor } : {}) };
    const result = session.scope.kind === "personal"
      ? await client.GET("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/ocr-reviews", {
          params: {
            path: { tenantId: session.tenantId, profileId: session.scope.profileId },
            query,
          },
          headers: authorization,
        })
      : await client.GET("/api/v1/tenants/{tenantId}/businesses/{businessId}/ocr-reviews", {
          params: {
            path: { tenantId: session.tenantId, businessId: session.scope.businessId },
            query,
          },
          headers: authorization,
        });
    if (!result.data) throw new CaptureApiError("Could not load OCR reviews", requestStatus(result));
    items.push(...result.data.items);
    cursor = result.data.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

export async function fetchOcrReview(
  session: CaptureSession,
  jobId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
): Promise<CaptureOcrReviewDetailV1> {
  const authorization = await getAppAuthorization(getToken, organizationId);
  const client = createAppApiClient(session.apiBaseUrl);
  const result = session.scope.kind === "personal"
    ? await client.GET("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/ocr-jobs/{jobId}/review", {
        params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId, jobId } },
        headers: authorization,
      })
    : await client.GET("/api/v1/tenants/{tenantId}/businesses/{businessId}/ocr-jobs/{jobId}/review", {
        params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, jobId } },
        headers: authorization,
      });
  if (!result.data) throw new CaptureApiError("Could not load OCR review", requestStatus(result));
  return result.data;
}

export async function completeOcrReview(
  session: CaptureSession,
  jobId: string,
  request: CaptureOcrCompleteRequestV1,
  idempotencyKey: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
): Promise<CaptureOcrReviewCompleteResponseV1> {
  const authorization = await getAppAuthorization(getToken, organizationId);
  const client = createAppApiClient(session.apiBaseUrl);
  const result = session.scope.kind === "personal"
    ? await client.POST("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/ocr-jobs/{jobId}/complete", {
        params: {
          path: { tenantId: session.tenantId, profileId: session.scope.profileId, jobId },
          header: { "idempotency-key": idempotencyKey },
        },
        headers: authorization,
        body: request,
      })
    : await client.POST("/api/v1/tenants/{tenantId}/businesses/{businessId}/ocr-jobs/{jobId}/complete", {
        params: {
          path: { tenantId: session.tenantId, businessId: session.scope.businessId, jobId },
          header: { "idempotency-key": idempotencyKey },
        },
        headers: authorization,
        body: request,
      });
  if (!result.data) throw new CaptureApiError("Could not complete OCR review", requestStatus(result));
  return result.data;
}

export async function deleteReceiptFile(
  session: CaptureSession,
  fileId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
): Promise<void> {
  const authorization = await getAppAuthorization(getToken, organizationId);
  const client = createAppApiClient(session.apiBaseUrl);
  const result = session.scope.kind === "personal"
    ? await client.DELETE("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/{fileId}", {
        params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId, fileId } },
        headers: authorization,
      })
    : await client.DELETE("/api/v1/tenants/{tenantId}/businesses/{businessId}/files/{fileId}", {
        params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, fileId } },
        headers: authorization,
      });
  if (result.error) throw new CaptureApiError("Could not remove receipt", requestStatus(result));
}

export async function fetchOcrJob(
  session: CaptureSession,
  fileId: string,
  jobId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
): Promise<ProcessingJob> {
  const authorization = await getAppAuthorization(getToken, organizationId);
  const client = createAppApiClient(session.apiBaseUrl);
  const result = session.scope.kind === "personal"
    ? await client.GET("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/{fileId}/ocr-jobs", {
        params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId, fileId } },
        headers: authorization,
      })
    : await client.GET("/api/v1/tenants/{tenantId}/businesses/{businessId}/files/{fileId}/ocr-jobs", {
        params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, fileId } },
        headers: authorization,
      });
  const job = result.data?.items.find((item) => item.id === jobId);
  if (!job) throw new CaptureApiError("Could not load OCR job", requestStatus(result));
  return job;
}
