import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  completeOcrReview,
  deleteReceiptFile,
  fetchOcrJob,
  fetchOcrReview,
  fetchOcrReviews,
  fetchTenantScopes,
  uploadQueuedReceipt,
} from "./api";
import type { CaptureSession } from "./session";

const session: CaptureSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal", profileId: "profile-1", label: "Personal" },
};

vi.mock("@expense-tax/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@expense-tax/contracts")>();
  return { ...actual, createAppApiClient: () => client };
});

const client = { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() };
const token = vi.fn().mockResolvedValue("tok");

const review = {
  schemaVersion: 1 as const,
  jobId: "job-1",
  fileId: "file-1",
  jobVersion: 4,
  fields: { merchant: "Shop", total: null, currency: "USD", incurredOn: null, taxAmount: null },
  issues: ["total_missing" as const],
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:01:00.000Z",
};

describe("fetchTenantScopes", () => {
  it("returns the scopes body for the Settings scope picker", async () => {
    const scopes = {
      personalProfiles: [{ id: "profile-1", tenantId: "tenant-1", name: "Personal", version: 1, createdAt: "t", updatedAt: "t" }],
      businesses: [],
    };
    client.GET.mockResolvedValue({ data: scopes });
    const getToken = vi.fn().mockResolvedValue("tok");

    const result = await fetchTenantScopes(session, getToken, "org_1");

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/scopes",
      expect.objectContaining({ params: { path: { tenantId: "tenant-1" } } }),
    );
    expect(result).toEqual(scopes);
  });

  it("throws when App API returns no body", async () => {
    client.GET.mockResolvedValue({ data: undefined });
    const getToken = vi.fn().mockResolvedValue("tok");

    await expect(fetchTenantScopes(session, getToken, "org_1")).rejects.toThrow(
      "Could not load profiles",
    );
  });
});

describe("OCR review API", () => {
  beforeEach(() => {
    client.GET.mockReset();
    client.POST.mockReset();
    client.DELETE.mockReset();
  });

  it("walks every review-list cursor", async () => {
    client.GET
      .mockResolvedValueOnce({ data: { items: [review], nextCursor: "next" } })
      .mockResolvedValueOnce({ data: { items: [{ ...review, jobId: "job-2" }], nextCursor: null } });

    const result = await fetchOcrReviews(session, token, "org_1");

    expect(result.map((item) => item.jobId)).toEqual(["job-1", "job-2"]);
    expect(client.GET).toHaveBeenNthCalledWith(2,
      "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/ocr-reviews",
      expect.objectContaining({ params: expect.objectContaining({ query: { status: "needs_input", limit: 100, cursor: "next" } }) }),
    );
  });

  it("loads scoped review detail", async () => {
    client.GET.mockResolvedValue({ data: { ...review, previewUrl: "/preview", previewExpiresAt: "2026-10-18T00:16:00.000Z" } });

    const result = await fetchOcrReview(session, "job-1", token, "org_1");

    expect(result.jobId).toBe("job-1");
    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/ocr-jobs/{jobId}/review",
      expect.objectContaining({ params: expect.objectContaining({ path: expect.objectContaining({ jobId: "job-1" }) }) }),
    );
  });

  it("completes a review with an idempotency key", async () => {
    client.POST.mockResolvedValue({ data: { jobId: "job-1", expenseId: "expense-1", jobVersion: 5 } });
    const request = {
      expectedJobVersion: 4,
      merchant: "Shop",
      total: "12.00",
      currency: "USD",
      incurredOn: "2026-10-18",
      tax: { kind: "no_tax" as const },
    };

    await completeOcrReview(session, "job-1", request, "complete-1", token, "org_1");

    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/ocr-jobs/{jobId}/complete",
      expect.objectContaining({ body: request, params: expect.objectContaining({ header: { "idempotency-key": "complete-1" } }) }),
    );
  });

  it("deletes the scoped receipt file", async () => {
    client.DELETE.mockResolvedValue({ error: undefined });

    await deleteReceiptFile(session, "file-1", token, "org_1");

    expect(client.DELETE).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/{fileId}",
      expect.objectContaining({ params: expect.objectContaining({ path: expect.objectContaining({ fileId: "file-1" }) }) }),
    );
  });

  it("polls the scoped file jobs and returns the requested job", async () => {
    client.GET.mockResolvedValue({ data: { items: [{ id: "job-1", status: "SUCCEEDED" }, { id: "job-2", status: "FAILED" }] } });

    const result = await fetchOcrJob(session, "file-1", "job-2", token, "org_1");

    expect(result).toMatchObject({ id: "job-2", status: "FAILED" });
  });
});

describe("Capture upload policy", () => {
  it("requests the Capture required-fields review policy", async () => {
    client.POST
      .mockResolvedValueOnce({ data: { uploadTarget: { url: "https://upload.test", requiredHeaders: {} }, uploadSession: { id: "session-1" } } })
      .mockResolvedValueOnce({ data: { id: "file-1" } })
      .mockResolvedValueOnce({ data: { id: "job-1" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const file = new File(["receipt"], "receipt.jpg", { type: "image/jpeg" });

    await uploadQueuedReceipt(session, {
      id: "queue-1",
      file,
      filename: file.name,
      contentType: file.type,
      modeKey: "ocr_mode_balanced",
      status: "queued",
      progress: 0,
      error: null,
      fileId: null,
      jobId: null,
      createdAt: "2026-10-18T00:00:00.000Z",
    }, token, "org_1");

    expect(client.POST).toHaveBeenNthCalledWith(3,
      "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/{fileId}/ocr-jobs",
      expect.objectContaining({ body: {
        modeKey: "ocr_mode_balanced",
        reviewPolicy: "capture_required_fields_v1",
      } }),
    );
    vi.unstubAllGlobals();
  });
});
