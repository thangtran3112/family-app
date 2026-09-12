import { describe, expect, it, vi } from "vitest";

import type { OfficeSession } from "./session";
import {
  DuplicateReviewError,
  fetchDuplicateMatches,
  getDuplicateReviewState,
  getSourceBadge,
  resolveDuplicateMatch,
} from "./api";

const session: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  businessId: "business-1",
  label: "Family",
};

describe("Office duplicate review API helpers", () => {
  it("loads pending business matches with the active organization token", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchDuplicateMatches(session, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches",
      expect.objectContaining({
        params: { path: { tenantId: "tenant-1", businessId: "business-1" }, query: { status: "pending", limit: 50 } },
        headers: { authorization: "Bearer office-token" },
      }),
    );
  });

  it("sends selected action, optimistic version, and idempotency key", async () => {
    const client = { POST: vi.fn().mockResolvedValue({ data: { status: "merged" } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await resolveDuplicateMatch(session, "match-1", "merge", 7, getToken, "org_123", client as never);

    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches/{matchId}/resolve",
      expect.objectContaining({
        params: { path: { tenantId: "tenant-1", businessId: "business-1", matchId: "match-1" } },
        body: { action: "merge", expectedMatchVersion: 7, idempotencyKey: expect.any(String) },
        headers: { authorization: "Bearer office-token" },
      }),
    );
  });

  it("surfaces a conflict response for refresh handling", async () => {
    const client = { POST: vi.fn().mockResolvedValue({ response: { status: 409 } }) };

    await expect(resolveDuplicateMatch(session, "match-1", "keep_both", 7, vi.fn().mockResolvedValue("office-token"), "org_123", client as never)).rejects.toMatchObject({
      name: "DuplicateReviewError",
      status: 409,
    } satisfies Partial<DuplicateReviewError>);
  });
});

describe("duplicate review presentation states", () => {
  it("fails closed until secure Office scope is ready", () => {
    expect(getDuplicateReviewState({ isLoaded: true, isSignedIn: true, organizationLoaded: true, hasSession: false, hasOrganization: true })).toBe("unauthorized");
    expect(getDuplicateReviewState({ isLoaded: true, isSignedIn: true, organizationLoaded: true, hasSession: true, hasOrganization: false })).toBe("unauthorized");
  });

  it("distinguishes loading, error, empty, pending, and conflict states", () => {
    expect(getDuplicateReviewState({ isLoaded: false, isSignedIn: false, organizationLoaded: false, hasSession: false, hasOrganization: false })).toBe("loading");
    expect(getDuplicateReviewState({ isLoaded: true, isSignedIn: true, organizationLoaded: true, hasSession: true, hasOrganization: true, error: "Request failed" })).toBe("error");
    expect(getDuplicateReviewState({ isLoaded: true, isSignedIn: true, organizationLoaded: true, hasSession: true, hasOrganization: true, items: [] })).toBe("empty");
    expect(getDuplicateReviewState({ isLoaded: true, isSignedIn: true, organizationLoaded: true, hasSession: true, hasOrganization: true, items: [{ id: "match-1" }] })).toBe("pending");
    expect(getDuplicateReviewState({ isLoaded: true, isSignedIn: true, organizationLoaded: true, hasSession: true, hasOrganization: true, items: [{ id: "match-1" }], conflict: true })).toBe("conflict");
  });

  it("labels evidence sources without exposing provider controls", () => {
    expect(getSourceBadge("file_sha256")).toEqual({ label: "Source file", tone: "ok" });
    expect(getSourceBadge("fingerprint")).toEqual({ label: "Expense fingerprint", tone: "ok" });
    expect(getSourceBadge("fuzzy_fields")).toEqual({ label: "Matching fields", tone: "warn" });
  });
});
